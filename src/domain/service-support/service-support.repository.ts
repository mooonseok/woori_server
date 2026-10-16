import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  lockRateLimitKey,
  tooManyRequests,
} from '../auth/auth-rate-limit.service';
import {
  INQUIRY_CREATE_LIMIT,
  INQUIRY_CREATE_WINDOW_HOURS,
  type InquiryCategoryValue,
} from './inquiry-policy';
export function noticeNotFound(): never {
  throw new NotFoundException({
    code: 'NOTICE_NOT_FOUND',
    message: '공지사항을 찾을 수 없어요.',
  });
}
export function inquiryNotFound(): never {
  throw new NotFoundException({
    code: 'INQUIRY_NOT_FOUND',
    message: '문의를 찾을 수 없어요.',
  });
}
// Members see only published notices whose publication time has arrived.
// publishedAt is written on the app clock (admin publish), so it is compared on
// the app clock too, never PostgreSQL now(): a few ms of host/DB clock skew must
// not hide a just-published notice.
const visibleNotice = (at: Date) =>
  Prisma.sql`n.status='PUBLISHED' AND n."publishedAt" IS NOT NULL AND n."publishedAt"<=${at}`;
type NoticeSummaryRow = {
  id: string;
  title: string;
  publishedAt: Date;
  updatedAt: Date;
};
type InquirySummaryRow = {
  id: string;
  category: string;
  title: string;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
};
const inquirySelect = {
  id: true,
  category: true,
  title: true,
  body: true,
  status: true,
  answer: true,
  createdAt: true,
  answeredAt: true,
} satisfies Prisma.InquirySelect;
function page<T extends { id: string }>(rows: T[], limit: number) {
  const more = rows.length > limit;
  if (more) rows.pop();
  return { items: rows, nextCursor: more ? rows.at(-1)!.id : null };
}
@Injectable()
export class ServiceSupportRepository {
  constructor(private readonly prisma: PrismaService) {}
  listNotices(limit: number, cursor?: string) {
    return this.prisma.client.$transaction(
      async (tx) => {
        // One instant for the anchor and the page, like now() in this snapshot.
        const at = new Date();
        // A cursor must still be a visible notice; otherwise restart from the top.
        if (cursor) {
          const anchor = await tx.$queryRaw<{ id: string }[]>(
            Prisma.sql`SELECT n.id FROM woori.notices n WHERE n.id=${cursor}::uuid AND ${visibleNotice(at)}`
          );
          if (!anchor.length) noticeNotFound();
        }
        // Compare against the stored microsecond timestamp, not a JS Date copy.
        const after = cursor
          ? Prisma.sql`AND (n."publishedAt",n.id)<(SELECT "publishedAt",id FROM woori.notices WHERE id=${cursor}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<NoticeSummaryRow[]>(
          Prisma.sql`SELECT n.id,n.title,n."publishedAt",n."updatedAt" FROM woori.notices n WHERE ${visibleNotice(at)} ${after} ORDER BY n."publishedAt" DESC,n.id DESC LIMIT ${limit + 1}`
        );
        return page(rows, limit);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  async notice(noticeId: string) {
    const rows = await this.prisma.client.$queryRaw<
      (NoticeSummaryRow & { body: string })[]
    >(
      Prisma.sql`SELECT n.id,n.title,n.body,n."publishedAt",n."updatedAt" FROM woori.notices n WHERE n.id=${noticeId}::uuid AND ${visibleNotice(new Date())}`
    );
    if (!rows.length) noticeNotFound();
    return rows[0];
  }
  listInquiries(userId: string, limit: number, cursor?: string) {
    return this.prisma.client.$transaction(
      async (tx) => {
        if (
          cursor &&
          !(await tx.inquiry.findFirst({
            where: { id: cursor, userId },
            select: { id: true },
          }))
        )
          inquiryNotFound();
        const after = cursor
          ? Prisma.sql`AND (i."createdAt",i.id)<(SELECT "createdAt",id FROM woori.inquiries WHERE id=${cursor}::uuid AND "userId"=${userId}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<InquirySummaryRow[]>(
          Prisma.sql`SELECT i.id,i.category,i.title,i.status,i."createdAt",i."answeredAt" FROM woori.inquiries i WHERE i."userId"=${userId}::uuid ${after} ORDER BY i."createdAt" DESC,i.id DESC LIMIT ${limit + 1}`
        );
        return page(rows, limit);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  async inquiry(userId: string, inquiryId: string) {
    const inquiry = await this.prisma.client.inquiry.findFirst({
      where: { id: inquiryId, userId },
      select: inquirySelect,
    });
    if (!inquiry) inquiryNotFound();
    return inquiry;
  }
  createInquiry(
    userId: string,
    data: { category: InquiryCategoryValue; title: string; body: string }
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      // Account deletion locks this row FOR UPDATE before erasing inquiries, so a
      // racing submission either commits first (and is erased) or sees DELETED.
      const users = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.users WHERE id=${userId}::uuid AND status='ACTIVE' FOR SHARE`;
      if (!users.length)
        throw new UnauthorizedException({
          code: 'AUTHENTICATION_REQUIRED',
          message: '로그인이 필요해요.',
        });
      // Exact rolling window over stored inquiries, serialized per user, so
      // invalid or rejected requests never count (uses the userId/createdAt index).
      await lockRateLimitKey(tx, 'inquiry-create', userId);
      const recent = await tx.$queryRaw<{ count: number }[]>(
        Prisma.sql`SELECT count(*)::int AS count FROM woori.inquiries WHERE "userId"=${userId}::uuid AND "createdAt" > now() - make_interval(hours => ${INQUIRY_CREATE_WINDOW_HOURS}::int)`
      );
      if (recent[0].count >= INQUIRY_CREATE_LIMIT) tooManyRequests();
      return tx.inquiry.create({
        data: { userId, ...data },
        select: inquirySelect,
      });
    });
  }
}
