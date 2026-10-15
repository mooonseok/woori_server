import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  lockRateLimitKey,
  tooManyRequests,
} from '../auth/auth-rate-limit.service';
import { lockReadablePhoto } from '../photos/photo-access';
import { notBlockedBySql } from '../blocks/block-visibility';
import {
  REPORT_CREATE_LIMIT,
  REPORT_CREATE_WINDOW_HOURS,
  type ReportReasonValue,
  type ReportTargetTypeValue,
} from './report-policy';
// Missing and inaccessible targets are not distinguished.
export function reportTargetNotFound(): never {
  throw new NotFoundException({
    code: 'REPORT_TARGET_NOT_FOUND',
    message: '신고할 대상을 찾을 수 없어요.',
  });
}
export function reportNotFound(): never {
  throw new NotFoundException({
    code: 'REPORT_NOT_FOUND',
    message: '신고 내역을 찾을 수 없어요.',
  });
}
function selfReport(): never {
  throw new BadRequestException({
    code: 'REPORT_SELF_NOT_ALLOWED',
    message: '본인이나 본인이 올린 콘텐츠는 신고할 수 없어요.',
  });
}
export type ReportInput = {
  targetType: ReportTargetTypeValue;
  targetId: string;
  groupId?: string;
  reason: ReportReasonValue;
  detail: string | null;
};
// The reporter sees processing status only: no target content or detail echo.
const reportSelect = {
  id: true,
  targetType: true,
  reason: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
} satisfies Prisma.ContentReportSelect;
type ReportRow = Prisma.ContentReportGetPayload<{
  select: typeof reportSelect;
}>;
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}
  // Same visibility predicates and shared lock order as photo, comment and
  // member reads: group -> membership/user -> album -> photo -> comment.
  private async lockTarget(
    tx: Prisma.TransactionClient,
    userId: string,
    input: ReportInput
  ) {
    if (input.targetType === 'PHOTO') {
      const access = await lockReadablePhoto(tx, input.targetId, userId);
      if (!access || (input.groupId && input.groupId !== access.groupId))
        reportTargetNotFound();
      return { groupId: access.groupId, targetUserId: access.uploaderId };
    }
    if (input.targetType === 'COMMENT') {
      const comment = await tx.comment.findUnique({
        where: { id: input.targetId },
        select: { photoId: true, groupId: true },
      });
      if (!comment || (input.groupId && input.groupId !== comment.groupId))
        reportTargetNotFound();
      const access = await lockReadablePhoto(tx, comment.photoId, userId);
      if (!access) reportTargetNotFound();
      // Same visibility as the comment list (authors this viewer blocked are hidden).
      const comments = await tx.$queryRaw<{ authorId: string }[]>(
        Prisma.sql`SELECT c."authorId" FROM woori.comments c WHERE c.id=${input.targetId}::uuid AND c."photoId"=${comment.photoId}::uuid AND c."groupId"=${access.groupId}::uuid AND c."deletedAt" IS NULL AND ${notBlockedBySql(userId, Prisma.sql`c."authorId"`)} FOR SHARE OF c`
      );
      if (!comments.length) reportTargetNotFound();
      return { groupId: access.groupId, targetUserId: comments[0].authorId };
    }
    const groupId = input.groupId!;
    const groups = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM woori.groups WHERE id=${groupId}::uuid AND status='ACTIVE' FOR SHARE`;
    if (!groups.length) reportTargetNotFound();
    const ids = [...new Set([userId, input.targetId])].sort();
    const members = await tx.$queryRaw<{ userId: string }[]>(
      Prisma.sql`SELECT m."userId" FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) AND m.status='ACTIVE' AND u.status='ACTIVE' ORDER BY m."userId" FOR SHARE OF m,u`
    );
    if (members.length !== ids.length) reportTargetNotFound();
    return { groupId, targetUserId: input.targetId };
  }
  create(userId: string, input: ReportInput) {
    return this.prisma.client.$transaction(async (tx) => {
      const target = await this.lockTarget(tx, userId, input);
      if (target.targetUserId === userId) selfReport();
      // Serializes this reporter's submissions: a repeated report returns the
      // stored one unchanged and only newly stored reports count toward the limit.
      await lockRateLimitKey(tx, 'report-create', userId);
      const key = {
        reporterId: userId,
        targetType: input.targetType,
        targetId: input.targetId,
      };
      const where = { reporterId_targetType_targetId: key };
      const existing = await tx.contentReport.findUnique({
        where,
        select: reportSelect,
      });
      if (existing) return { ...existing, duplicate: true };
      // Exact rolling window over stored reports (reporterId/createdAt index).
      const recent = await tx.$queryRaw<{ count: number }[]>(
        Prisma.sql`SELECT count(*)::int AS count FROM woori.content_reports WHERE "reporterId"=${userId}::uuid AND "createdAt" > now() - make_interval(hours => ${REPORT_CREATE_WINDOW_HOURS}::int)`
      );
      if (recent[0].count >= REPORT_CREATE_LIMIT) tooManyRequests();
      const inserted = await tx.contentReport.createMany({
        data: [
          {
            ...key,
            groupId: target.groupId,
            targetUserId: target.targetUserId,
            reason: input.reason,
            detail: input.detail,
          },
        ],
        skipDuplicates: true,
      });
      const report = await tx.contentReport.findUniqueOrThrow({
        where,
        select: reportSelect,
      });
      return { ...report, duplicate: inserted.count === 0 };
    });
  }
  list(userId: string, limit: number, cursor?: string) {
    return this.prisma.client.$transaction(
      async (tx) => {
        if (
          cursor &&
          !(await tx.contentReport.findFirst({
            where: { id: cursor, reporterId: userId },
            select: { id: true },
          }))
        )
          reportNotFound();
        const after = cursor
          ? Prisma.sql`AND (r."createdAt",r.id)<(SELECT "createdAt",id FROM woori.content_reports WHERE id=${cursor}::uuid AND "reporterId"=${userId}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<ReportRow[]>(
          Prisma.sql`SELECT r.id,r."targetType",r.reason,r.status,r."createdAt",r."resolvedAt" FROM woori.content_reports r WHERE r."reporterId"=${userId}::uuid ${after} ORDER BY r."createdAt" DESC,r.id DESC LIMIT ${limit + 1}`
        );
        const more = rows.length > limit;
        if (more) rows.pop();
        return { items: rows, nextCursor: more ? rows.at(-1)!.id : null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
}
