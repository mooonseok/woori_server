import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { markPhotosDeleted } from '../domain/photos/photo-deletion';
import { writeAdminAudit } from './admin-audit';
import type {
  AdminReportAction,
  ReportResolution,
} from './admin-content-policy';
import { adminCursorInvalid, adminNotFound } from './admin-errors';
import { suspendMember } from './member-suspension';

type Tx = Prisma.TransactionClient;
type ReportRow = {
  id: string;
  targetType: 'PHOTO' | 'COMMENT' | 'USER';
  targetId: string;
  reason: string;
  status: string;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  detail: string | null;
  groupId: string;
  groupName: string;
  groupStatus: string;
  reporterId: string;
  reporterDisplayName: string;
  reporterStatus: string;
  targetUserId: string;
  targetUserDisplayName: string;
  targetUserStatus: string;
  openReportsOnTarget: number;
};
export function reportNotFound(): never {
  adminNotFound('ADMIN_REPORT_NOT_FOUND', '신고를 찾을 수 없어요.');
}
function alreadyClosed(): never {
  throw new ConflictException({
    code: 'ADMIN_REPORT_ALREADY_CLOSED',
    message: '이미 처리가 끝난 신고예요.',
  });
}
const OPEN = Prisma.sql`('RECEIVED','REVIEWING')`;
const isOpen = (status: string) =>
  status === 'RECEIVED' || status === 'REVIEWING';
// One projection for lists, details and mutation responses.
const reportColumns = Prisma.sql`r.id,r."targetType"::text AS "targetType",r."targetId",r.reason::text AS reason,r.status::text AS status,r.resolution,r."createdAt",r."resolvedAt",r.detail,
  g.id AS "groupId",g.name AS "groupName",g.status::text AS "groupStatus",
  rp.id AS "reporterId",rp."displayName" AS "reporterDisplayName",rp.status::text AS "reporterStatus",
  tu.id AS "targetUserId",tu."displayName" AS "targetUserDisplayName",tu.status::text AS "targetUserStatus",
  (SELECT count(*)::int FROM woori.content_reports o WHERE o."targetType"=r."targetType" AND o."targetId"=r."targetId" AND o.status IN ${OPEN}) AS "openReportsOnTarget"`;
const reportJoins = Prisma.sql`FROM woori.content_reports r JOIN woori.groups g ON g.id=r."groupId" JOIN woori.users rp ON rp.id=r."reporterId" JOIN woori.users tu ON tu.id=r."targetUserId"`;
function summary(row: ReportRow) {
  return {
    id: row.id,
    targetType: row.targetType,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    group: { id: row.groupId, name: row.groupName, status: row.groupStatus },
    // A withdrawn reporter is DELETED (its free-text detail was erased).
    reporter: {
      id: row.reporterId,
      displayName: row.reporterDisplayName,
      status: row.reporterStatus,
    },
    targetUser: {
      id: row.targetUserId,
      displayName: row.targetUserDisplayName,
      status: row.targetUserStatus,
    },
    openReportsOnTarget: row.openReportsOnTarget,
  };
}
// Target summaries carry identifiers and state only: no photo bytes and no
// comment body (those need the audited view endpoints).
async function targetSummary(tx: Tx, row: ReportRow) {
  if (row.targetType === 'PHOTO') {
    const photo = await tx.photo.findUnique({
      where: { id: row.targetId },
      select: {
        id: true,
        albumId: true,
        status: true,
        createdAt: true,
        album: { select: { title: true } },
      },
    });
    return photo
      ? {
          photoId: photo.id,
          albumId: photo.albumId,
          albumTitle: photo.album.title,
          status: photo.status,
          uploadedAt: photo.createdAt,
        }
      : null;
  }
  if (row.targetType === 'COMMENT') {
    const comment = await tx.comment.findUnique({
      where: { id: row.targetId },
      select: {
        id: true,
        photoId: true,
        kind: true,
        deletedAt: true,
        createdAt: true,
      },
    });
    return comment
      ? {
          commentId: comment.id,
          photoId: comment.photoId,
          kind: comment.kind,
          deleted: Boolean(comment.deletedAt),
          createdAt: comment.createdAt,
        }
      : null;
  }
  const membership = await tx.membership.findUnique({
    where: {
      groupId_userId: { groupId: row.groupId, userId: row.targetId },
    },
    select: { status: true },
  });
  return { userId: row.targetId, membershipStatus: membership?.status ?? null };
}
async function readReport(tx: Tx, reportId: string) {
  const rows = await tx.$queryRaw<ReportRow[]>(
    Prisma.sql`SELECT ${reportColumns} ${reportJoins} WHERE r.id=${reportId}::uuid`
  );
  if (!rows.length) reportNotFound();
  return rows[0];
}
async function reportDetail(tx: Tx, reportId: string) {
  const row = await readReport(tx, reportId);
  return {
    ...summary(row),
    detail: row.detail,
    target: await targetSummary(tx, row),
  };
}
async function lockReport(tx: Tx, reportId: string) {
  const rows = await tx.$queryRaw<
    { status: string }[]
  >`SELECT status::text AS status FROM woori.content_reports WHERE id=${reportId}::uuid FOR UPDATE`;
  if (!rows.length) reportNotFound();
  return rows[0].status;
}
const reportAudit = (
  adminId: string,
  reportId: string,
  action:
    | 'ADMIN_REPORT_VIEWED'
    | 'ADMIN_REPORT_REVIEWED'
    | 'ADMIN_REPORT_DISMISSED'
    | 'ADMIN_REPORT_RESOLVED'
) => ({
  adminId,
  action,
  targetType: 'REPORT' as const,
  targetId: reportId,
});

@Injectable()
export class AdminReportsRepository {
  constructor(private readonly prisma: PrismaService) {}
  // OPEN (RECEIVED + REVIEWING) lists oldest first so the queue is worked in
  // order; every other filter lists newest first. Reports are never deleted.
  async list(
    limit: number,
    status: string,
    targetType?: string,
    cursor?: string
  ) {
    const client = this.prisma.client;
    if (
      cursor &&
      !(await client.contentReport.findUnique({
        where: { id: cursor },
        select: { id: true },
      }))
    )
      adminCursorInvalid('ADMIN_REPORT_CURSOR_INVALID');
    const open = status === 'OPEN';
    const conditions = [
      open
        ? Prisma.sql`AND r.status IN ${OPEN}`
        : Prisma.sql`AND r.status=${status}::woori."ReportStatus"`,
      targetType
        ? Prisma.sql`AND r."targetType"=${targetType}::woori."ReportTargetType"`
        : Prisma.empty,
      cursor
        ? open
          ? Prisma.sql`AND (r."createdAt",r.id)>(SELECT "createdAt",id FROM woori.content_reports WHERE id=${cursor}::uuid)`
          : Prisma.sql`AND (r."createdAt",r.id)<(SELECT "createdAt",id FROM woori.content_reports WHERE id=${cursor}::uuid)`
        : Prisma.empty,
    ];
    const order = open
      ? Prisma.sql`ORDER BY r."createdAt" ASC,r.id ASC`
      : Prisma.sql`ORDER BY r."createdAt" DESC,r.id DESC`;
    const rows = await client.$queryRaw<ReportRow[]>(
      Prisma.sql`SELECT ${reportColumns} ${reportJoins} WHERE TRUE ${Prisma.join(conditions, ' ')} ${order} LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: rows.map(summary),
      nextCursor: more ? rows.at(-1)!.id : null,
    };
  }
  // Reading a report (including the reporter's free text) is audited.
  view(adminId: string, reportId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const detail = await reportDetail(tx, reportId);
      await writeAdminAudit(
        tx,
        reportAudit(adminId, reportId, 'ADMIN_REPORT_VIEWED')
      );
      return detail;
    });
  }
  // RECEIVED → REVIEWING. Already REVIEWING changes nothing but the response
  // still discloses the report (reporter text): audited as a view.
  review(adminId: string, reportId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const status = await lockReport(tx, reportId);
      if (!isOpen(status)) alreadyClosed();
      if (status !== 'RECEIVED')
        await writeAdminAudit(
          tx,
          reportAudit(adminId, reportId, 'ADMIN_REPORT_VIEWED')
        );
      else {
        await tx.contentReport.update({
          where: { id: reportId },
          data: { status: 'REVIEWING' },
          select: { id: true },
        });
        await writeAdminAudit(tx, {
          ...reportAudit(adminId, reportId, 'ADMIN_REPORT_REVIEWED'),
          metadata: { previousStatus: status, status: 'REVIEWING' },
        });
      }
      return reportDetail(tx, reportId);
    });
  }
  dismiss(adminId: string, reportId: string, reason: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const status = await lockReport(tx, reportId);
      if (!isOpen(status)) alreadyClosed();
      await tx.contentReport.update({
        where: { id: reportId },
        data: {
          status: 'DISMISSED',
          resolution: 'NO_ACTION',
          resolvedAt: new Date(),
        },
        select: { id: true },
      });
      await writeAdminAudit(tx, {
        ...reportAudit(adminId, reportId, 'ADMIN_REPORT_DISMISSED'),
        reason,
        metadata: { previousStatus: status, status: 'DISMISSED' },
      });
      return reportDetail(tx, reportId);
    });
  }
  // Applies the action and resolves this report plus every other open report on
  // the same target. Lock order: content (group → photo → comment) or the
  // target user (then its credentials), and the report rows last, matching
  // member deletion, report filing and account deletion (which reaches report
  // rows after groups, memberships and users).
  async resolve(
    adminId: string,
    reportId: string,
    action: AdminReportAction,
    reason: string
  ) {
    const initial = await this.prisma.client.contentReport.findUnique({
      where: { id: reportId },
      select: { status: true, targetType: true },
    });
    if (!initial) reportNotFound();
    if (!isOpen(initial.status)) alreadyClosed();
    if (action === 'DELETE_CONTENT' && initial.targetType === 'USER')
      throw new BadRequestException({
        code: 'ADMIN_ACTION_NOT_APPLICABLE',
        message: '회원 신고에는 콘텐츠 삭제를 적용할 수 없어요.',
      });
    return this.prisma.client.$transaction(
      async (tx) => {
        const report = await tx.contentReport.findUniqueOrThrow({
          where: { id: reportId },
          select: {
            targetType: true,
            targetId: true,
            targetUserId: true,
          },
        });
        const now = new Date();
        const effectApplied =
          action === 'SUSPEND_USER'
            ? await this.suspend(tx, adminId, reportId, report, reason, now)
            : report.targetType === 'PHOTO'
              ? await this.deletePhoto(tx, adminId, reportId, report, reason)
              : await this.deleteComment(
                  tx,
                  adminId,
                  reportId,
                  report,
                  reason,
                  now
                );
        const locked = await tx.$queryRaw<{ id: string; status: string }[]>(
          Prisma.sql`SELECT id,status::text AS status FROM woori.content_reports WHERE id=${reportId}::uuid OR ("targetType"=${report.targetType}::woori."ReportTargetType" AND "targetId"=${report.targetId}::uuid AND status IN ${OPEN}) ORDER BY id FOR UPDATE`
        );
        // Closed by a concurrent request: roll back the action as well.
        if (!isOpen(locked.find((row) => row.id === reportId)?.status ?? ''))
          alreadyClosed();
        const resolution: ReportResolution =
          action === 'SUSPEND_USER' ? 'USER_SUSPENDED' : 'CONTENT_DELETED';
        const ids = locked
          .filter((row) => isOpen(row.status))
          .map((row) => row.id);
        await tx.contentReport.updateMany({
          where: { id: { in: ids } },
          data: { status: 'RESOLVED', resolution, resolvedAt: now },
        });
        const alsoResolved = ids.length - 1;
        await writeAdminAudit(tx, {
          ...reportAudit(adminId, reportId, 'ADMIN_REPORT_RESOLVED'),
          reason,
          metadata: { action, alsoResolved, effectApplied },
        });
        return { ...(await reportDetail(tx, reportId)), alsoResolved };
      },
      { timeout: 15_000 }
    );
  }
  private async suspend(
    tx: Tx,
    adminId: string,
    reportId: string,
    report: { targetUserId: string },
    reason: string,
    now: Date
  ) {
    const result = await suspendMember(tx, report.targetUserId, now);
    if (result.changed)
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_USER_SUSPENDED',
        targetType: 'USER',
        targetId: report.targetUserId,
        reason,
        metadata: {
          reportId,
          previousStatus: result.previousStatus,
          status: 'SUSPENDED',
        },
      });
    return result.changed;
  }
  // Same path as member/owner photo deletion: tombstone, quota release and the
  // durable media cleanup job under the group row lock. Notifications about a
  // deleted photo are hidden by the shared read predicates, as for members.
  private async deletePhoto(
    tx: Tx,
    adminId: string,
    reportId: string,
    report: { targetId: string },
    reason: string
  ) {
    const photo = await tx.photo.findUnique({
      where: { id: report.targetId },
      select: { groupId: true },
    });
    if (!photo) return false;
    await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${photo.groupId}::uuid FOR UPDATE`;
    const deleted = await markPhotosDeleted(tx, photo.groupId, {
      id: report.targetId,
    });
    if (deleted)
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_CONTENT_DELETED',
        targetType: 'PHOTO',
        targetId: report.targetId,
        reason,
        metadata: { reportId, groupId: photo.groupId },
      });
    return deleted > 0;
  }
  // Soft delete like an owner's comment deletion (body kept for the operator),
  // after the same group → photo shared locks as comment mutations.
  private async deleteComment(
    tx: Tx,
    adminId: string,
    reportId: string,
    report: { targetId: string },
    reason: string,
    now: Date
  ) {
    const comment = await tx.comment.findUnique({
      where: { id: report.targetId },
      select: { groupId: true, photoId: true },
    });
    if (!comment) return false;
    await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${comment.groupId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM woori.photos WHERE id=${comment.photoId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM woori.comments WHERE id=${report.targetId}::uuid FOR UPDATE`;
    const updated = await tx.comment.updateMany({
      where: { id: report.targetId, deletedAt: null },
      data: { deletedAt: now },
    });
    if (updated.count)
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_CONTENT_DELETED',
        targetType: 'COMMENT',
        targetId: report.targetId,
        reason,
        metadata: {
          reportId,
          groupId: comment.groupId,
          photoId: comment.photoId,
        },
      });
    return updated.count > 0;
  }
}
