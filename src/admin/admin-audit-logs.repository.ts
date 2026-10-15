import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
type AuditRow = {
  id: string;
  adminId: string | null;
  adminDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
};
@Injectable()
export class AdminAuditLogsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async list(limit: number, cursor?: string, action?: string) {
    const client = this.prisma.client;
    // Audit rows are never deleted, so an unknown cursor is a client error.
    if (cursor) {
      const anchor = await client.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM woori.admin_audit_logs WHERE id=${cursor}::uuid`
      );
      if (!anchor.length)
        throw new BadRequestException({
          code: 'ADMIN_AUDIT_CURSOR_INVALID',
          message: '목록을 처음부터 다시 불러와 주세요.',
        });
    }
    const filter = action ? Prisma.sql`AND l.action=${action}` : Prisma.empty;
    // Compare against the stored microsecond timestamp, not a JS Date copy.
    const after = cursor
      ? Prisma.sql`AND (l."createdAt",l.id)<(SELECT "createdAt",id FROM woori.admin_audit_logs WHERE id=${cursor}::uuid)`
      : Prisma.empty;
    const rows = await client.$queryRaw<AuditRow[]>(
      Prisma.sql`SELECT l.id,l."adminId",a."displayName" AS "adminDisplayName",l.action,l."targetType",l."targetId",l.reason,l.metadata,l."createdAt" FROM woori.admin_audit_logs l LEFT JOIN woori.admin_accounts a ON a.id=l."adminId" WHERE TRUE ${filter} ${after} ORDER BY l."createdAt" DESC,l.id DESC LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: rows.map((row) => ({
        id: row.id,
        admin: row.adminId
          ? { id: row.adminId, displayName: row.adminDisplayName ?? '' }
          : null,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        metadata: row.metadata ?? {},
        createdAt: row.createdAt,
      })),
      nextCursor: more ? rows.at(-1)!.id : null,
    };
  }
}
