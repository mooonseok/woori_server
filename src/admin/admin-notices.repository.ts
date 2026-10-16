import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { writeAdminAudit } from './admin-audit';
import { adminCursorInvalid, adminNotFound } from './admin-errors';
const noticeDetail = {
  id: true,
  title: true,
  body: true,
  status: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NoticeSelect;
type NoticeSummaryRow = {
  id: string;
  title: string;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  scheduled: boolean;
};
export function noticeNotFound(): never {
  adminNotFound('ADMIN_NOTICE_NOT_FOUND', '공지사항을 찾을 수 없어요.');
}
type Tx = Prisma.TransactionClient;
async function lockNotice(tx: Tx, noticeId: string) {
  const rows = await tx.$queryRaw<
    { id: string; status: string }[]
  >`SELECT id,status::text AS status FROM woori.notices WHERE id=${noticeId}::uuid FOR UPDATE`;
  if (!rows.length) noticeNotFound();
  return rows[0];
}
const audit = (
  tx: Tx,
  adminId: string,
  noticeId: string,
  action:
    | 'ADMIN_NOTICE_CREATED'
    | 'ADMIN_NOTICE_UPDATED'
    | 'ADMIN_NOTICE_PUBLISHED'
    | 'ADMIN_NOTICE_ARCHIVED',
  status: string
) =>
  writeAdminAudit(tx, {
    adminId,
    action,
    targetType: 'NOTICE',
    targetId: noticeId,
    metadata: { status },
  });
@Injectable()
export class AdminNoticesRepository {
  constructor(private readonly prisma: PrismaService) {}
  // Newest-updated first. Notices are never deleted, so an unknown cursor is a
  // client error. scheduled: published with a future publication time (app
  // clock, the clock that wrote publishedAt).
  async list(limit: number, status?: string, cursor?: string) {
    const client = this.prisma.client;
    if (
      cursor &&
      !(await client.notice.findUnique({
        where: { id: cursor },
        select: { id: true },
      }))
    )
      adminCursorInvalid('ADMIN_NOTICE_CURSOR_INVALID');
    const filter = status
      ? Prisma.sql`AND n.status=${status}::woori."NoticeStatus"`
      : Prisma.empty;
    const after = cursor
      ? Prisma.sql`AND (n."updatedAt",n.id)<(SELECT "updatedAt",id FROM woori.notices WHERE id=${cursor}::uuid)`
      : Prisma.empty;
    const rows = await client.$queryRaw<NoticeSummaryRow[]>(
      Prisma.sql`SELECT n.id,n.title,n.status::text AS status,n."publishedAt",n."createdAt",n."updatedAt",(n.status='PUBLISHED' AND n."publishedAt">${new Date()}) AS scheduled FROM woori.notices n WHERE TRUE ${filter} ${after} ORDER BY n."updatedAt" DESC,n.id DESC LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return { items: rows, nextCursor: more ? rows.at(-1)!.id : null };
  }
  async detail(noticeId: string) {
    const notice = await this.prisma.client.notice.findUnique({
      where: { id: noticeId },
      select: noticeDetail,
    });
    if (!notice) noticeNotFound();
    return notice;
  }
  create(adminId: string, data: { title: string; body: string }) {
    return this.prisma.client.$transaction(async (tx) => {
      const notice = await tx.notice.create({
        data: { ...data, status: 'DRAFT' },
        select: noticeDetail,
      });
      await audit(tx, adminId, notice.id, 'ADMIN_NOTICE_CREATED', 'DRAFT');
      return notice;
    });
  }
  update(
    adminId: string,
    noticeId: string,
    data: { title?: string; body?: string }
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      await lockNotice(tx, noticeId);
      const notice = await tx.notice.update({
        where: { id: noticeId },
        data,
        select: noticeDetail,
      });
      await audit(tx, adminId, noticeId, 'ADMIN_NOTICE_UPDATED', notice.status);
      return notice;
    });
  }
  // Publishing (again) is allowed from any status, including rescheduling a
  // published notice or re-publishing an archived one.
  publish(adminId: string, noticeId: string, publishedAt: Date) {
    return this.prisma.client.$transaction(async (tx) => {
      await lockNotice(tx, noticeId);
      const notice = await tx.notice.update({
        where: { id: noticeId },
        data: { status: 'PUBLISHED', publishedAt },
        select: noticeDetail,
      });
      await audit(tx, adminId, noticeId, 'ADMIN_NOTICE_PUBLISHED', 'PUBLISHED');
      return notice;
    });
  }
  // Idempotent: archiving an archived notice changes nothing and is not audited.
  archive(adminId: string, noticeId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const current = await lockNotice(tx, noticeId);
      if (current.status === 'ARCHIVED')
        return tx.notice.findUniqueOrThrow({
          where: { id: noticeId },
          select: noticeDetail,
        });
      const notice = await tx.notice.update({
        where: { id: noticeId },
        data: { status: 'ARCHIVED' },
        select: noticeDetail,
      });
      await audit(tx, adminId, noticeId, 'ADMIN_NOTICE_ARCHIVED', 'ARCHIVED');
      return notice;
    });
  }
}
