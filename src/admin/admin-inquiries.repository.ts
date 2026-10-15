import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { writeAdminAudit } from './admin-audit';
import { adminCursorInvalid, adminNotFound } from './admin-errors';
const inquiryDetail = {
  id: true,
  category: true,
  title: true,
  body: true,
  status: true,
  answer: true,
  createdAt: true,
  answeredAt: true,
  user: {
    select: { id: true, displayName: true, username: true, status: true },
  },
} satisfies Prisma.InquirySelect;
type InquiryDetailRow = Prisma.InquiryGetPayload<{
  select: typeof inquiryDetail;
}>;
type InquirySummaryRow = {
  id: string;
  category: string;
  title: string;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
  memberId: string;
  memberDisplayName: string;
  memberUsername: string;
};
export function inquiryNotFound(): never {
  adminNotFound('ADMIN_INQUIRY_NOT_FOUND', '문의를 찾을 수 없어요.');
}
function detail(row: InquiryDetailRow) {
  const { user, ...inquiry } = row;
  return { ...inquiry, member: user };
}
type Tx = Prisma.TransactionClient;
// Account deletion erases the member's inquiries while holding the user row;
// locking the inquiry row first means a concurrent erasure either committed
// (the row is gone: 404) or waits until this change commits.
async function lockInquiry(tx: Tx, inquiryId: string) {
  const rows = await tx.$queryRaw<
    { id: string; status: string; userId: string }[]
  >`SELECT id,status::text AS status,"userId" FROM woori.inquiries WHERE id=${inquiryId}::uuid FOR UPDATE`;
  if (!rows.length) inquiryNotFound();
  return rows[0];
}
@Injectable()
export class AdminInquiriesRepository {
  constructor(private readonly prisma: PrismaService) {}
  // Newest first. Titles are listed for triage; bodies only in the detail.
  async list(
    limit: number,
    filters: { status?: string; category?: string },
    cursor?: string
  ) {
    const client = this.prisma.client;
    if (
      cursor &&
      !(await client.inquiry.findUnique({
        where: { id: cursor },
        select: { id: true },
      }))
    )
      adminCursorInvalid('ADMIN_INQUIRY_CURSOR_INVALID');
    const conditions = [
      filters.status
        ? Prisma.sql`AND i.status=${filters.status}::woori."InquiryStatus"`
        : Prisma.empty,
      filters.category
        ? Prisma.sql`AND i.category=${filters.category}::woori."InquiryCategory"`
        : Prisma.empty,
      cursor
        ? Prisma.sql`AND (i."createdAt",i.id)<(SELECT "createdAt",id FROM woori.inquiries WHERE id=${cursor}::uuid)`
        : Prisma.empty,
    ];
    const rows = await client.$queryRaw<InquirySummaryRow[]>(
      Prisma.sql`SELECT i.id,i.category::text AS category,i.title,i.status::text AS status,i."createdAt",i."answeredAt",u.id AS "memberId",u."displayName" AS "memberDisplayName",u.username AS "memberUsername" FROM woori.inquiries i JOIN woori.users u ON u.id=i."userId" WHERE TRUE ${Prisma.join(conditions, ' ')} ORDER BY i."createdAt" DESC,i.id DESC LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt,
        answeredAt: row.answeredAt,
        member: {
          id: row.memberId,
          displayName: row.memberDisplayName,
          username: row.memberUsername,
        },
      })),
      nextCursor: more ? rows.at(-1)!.id : null,
    };
  }
  // Reading a member's inquiry body is audited.
  view(adminId: string, inquiryId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const inquiry = await tx.inquiry.findUnique({
        where: { id: inquiryId },
        select: inquiryDetail,
      });
      if (!inquiry) inquiryNotFound();
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_INQUIRY_VIEWED',
        targetType: 'INQUIRY',
        targetId: inquiryId,
        metadata: { userId: inquiry.user.id },
      });
      return detail(inquiry);
    });
  }
  // Re-answering overwrites the answer and its time.
  answer(adminId: string, inquiryId: string, answer: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const current = await lockInquiry(tx, inquiryId);
      const inquiry = await tx.inquiry.update({
        where: { id: inquiryId },
        data: { status: 'ANSWERED', answer, answeredAt: new Date() },
        select: inquiryDetail,
      });
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_INQUIRY_ANSWERED',
        targetType: 'INQUIRY',
        targetId: inquiryId,
        metadata: {
          userId: current.userId,
          previousStatus: current.status,
          status: 'ANSWERED',
        },
      });
      return detail(inquiry);
    });
  }
  // Any status may move to IN_PROGRESS or CLOSED; the same status is a no-op.
  changeStatus(
    adminId: string,
    inquiryId: string,
    status: 'IN_PROGRESS' | 'CLOSED'
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const current = await lockInquiry(tx, inquiryId);
      if (current.status === status)
        return detail(
          await tx.inquiry.findUniqueOrThrow({
            where: { id: inquiryId },
            select: inquiryDetail,
          })
        );
      const inquiry = await tx.inquiry.update({
        where: { id: inquiryId },
        data: { status },
        select: inquiryDetail,
      });
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_INQUIRY_STATUS_CHANGED',
        targetType: 'INQUIRY',
        targetId: inquiryId,
        metadata: {
          userId: current.userId,
          previousStatus: current.status,
          status,
        },
      });
      return detail(inquiry);
    });
  }
}
