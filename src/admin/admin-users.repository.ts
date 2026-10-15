import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { AccountDeletionRepository } from '../domain/auth/account-deletion.repository';
import { writeAdminAudit } from './admin-audit';
import { adminCursorInvalid, adminNotFound } from './admin-errors';
import { suspendMember, unsuspendMember } from './member-suspension';

type Tx = Prisma.TransactionClient;
type UserRow = {
  id: string;
  username: string;
  displayName: string;
  email: string;
  status: string;
  emailVerified: boolean;
  createdAt: Date;
  activeGroupCount: number;
};
export function userNotFound(): never {
  adminNotFound('ADMIN_USER_NOT_FOUND', '회원을 찾을 수 없어요.');
}
function alreadyDeleted(): never {
  throw new ConflictException({
    code: 'ADMIN_USER_ALREADY_DELETED',
    message: '이미 탈퇴한 회원이에요.',
  });
}
// First two characters of the local part, then ***@domain. Deleted accounts
// carry a tombstone address and expose none.
export function maskEmail(email: string, status: string) {
  if (status === 'DELETED') return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return `${[...email.slice(0, at)].slice(0, 2).join('')}***@${email.slice(at + 1)}`;
}
// Escapes LIKE wildcards so a query is matched literally.
export function likeLiteral(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
const userColumns = Prisma.sql`u.id,u.username,u."displayName",u.email,u.status::text AS status,(u."verifiedAt" IS NOT NULL) AS "emailVerified",u."createdAt",
  (SELECT count(*)::int FROM woori.memberships m JOIN woori.groups g ON g.id=m."groupId" AND g.status='ACTIVE' WHERE m."userId"=u.id AND m.status='ACTIVE') AS "activeGroupCount"`;
// Minimal metadata only: never password hashes, sessions, push data or the
// full email address.
function summary(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    emailMasked: maskEmail(row.email, row.status),
    status: row.status,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    activeGroupCount: row.activeGroupCount,
  };
}
async function readUser(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<UserRow[]>(
    Prisma.sql`SELECT ${userColumns} FROM woori.users u WHERE u.id=${userId}::uuid`
  );
  if (!rows.length) userNotFound();
  return rows[0];
}
async function userDetail(tx: Tx, userId: string) {
  const user = summary(await readUser(tx, userId));
  const memberships = await tx.$queryRaw<
    {
      groupId: string;
      groupName: string;
      groupStatus: string;
      role: string;
      status: string;
      joinedAt: Date | null;
    }[]
  >`SELECT g.id AS "groupId",g.name AS "groupName",g.status::text AS "groupStatus",m.role::text AS role,m.status::text AS status,m."joinedAt" FROM woori.memberships m JOIN woori.groups g ON g.id=m."groupId" WHERE m."userId"=${userId}::uuid ORDER BY m."joinedAt" DESC NULLS LAST,g.id LIMIT 200`;
  const counts = (
    await tx.$queryRaw<
      {
        photos: number;
        comments: number;
        openReportsAgainst: number;
        openReportsFiled: number;
        inquiries: number;
      }[]
    >`SELECT
      (SELECT count(*)::int FROM woori.photos p WHERE p."uploaderId"=${userId}::uuid AND p.status='READY' AND p."deletedAt" IS NULL) AS photos,
      (SELECT count(*)::int FROM woori.comments c WHERE c."authorId"=${userId}::uuid AND c."deletedAt" IS NULL) AS comments,
      (SELECT count(*)::int FROM woori.content_reports r WHERE r."targetUserId"=${userId}::uuid AND r.status IN ('RECEIVED','REVIEWING')) AS "openReportsAgainst",
      (SELECT count(*)::int FROM woori.content_reports r WHERE r."reporterId"=${userId}::uuid AND r.status IN ('RECEIVED','REVIEWING')) AS "openReportsFiled",
      (SELECT count(*)::int FROM woori.inquiries i WHERE i."userId"=${userId}::uuid) AS inquiries`
  )[0];
  return {
    ...user,
    memberships: memberships.map((row) => ({
      group: { id: row.groupId, name: row.groupName, status: row.groupStatus },
      role: row.role,
      status: row.status,
      joinedAt: row.joinedAt,
    })),
    counts,
  };
}
const userAudit = (adminId: string, userId: string, reason?: string) => ({
  adminId,
  targetType: 'USER' as const,
  targetId: userId,
  ...(reason ? { reason } : {}),
});

@Injectable()
export class AdminUsersRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletion: AccountDeletionRepository
  ) {}
  // Newest accounts first. DELETED accounts are listed only when asked for.
  async list(
    limit: number,
    filters: { query?: string; status?: string },
    cursor?: string
  ) {
    const client = this.prisma.client;
    if (
      cursor &&
      !(await client.user.findUnique({
        where: { id: cursor },
        select: { id: true },
      }))
    )
      adminCursorInvalid('ADMIN_USER_CURSOR_INVALID');
    const conditions = [
      filters.status
        ? Prisma.sql`AND u.status=${filters.status}::woori."UserStatus"`
        : Prisma.sql`AND u.status<>'DELETED'`,
      filters.query
        ? Prisma.sql`AND (u.username LIKE ${`${likeLiteral(filters.query.toLowerCase())}%`} ESCAPE '\\' OR u."displayName" ILIKE ${`%${likeLiteral(filters.query)}%`} ESCAPE '\\')`
        : Prisma.empty,
      cursor
        ? Prisma.sql`AND (u."createdAt",u.id)<(SELECT "createdAt",id FROM woori.users WHERE id=${cursor}::uuid)`
        : Prisma.empty,
    ];
    const rows = await client.$queryRaw<UserRow[]>(
      Prisma.sql`SELECT ${userColumns} FROM woori.users u WHERE TRUE ${Prisma.join(conditions, ' ')} ORDER BY u."createdAt" DESC,u.id DESC LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: rows.map(summary),
      nextCursor: more ? rows.at(-1)!.id : null,
    };
  }
  view(adminId: string, userId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const detail = await userDetail(tx, userId);
      await writeAdminAudit(tx, {
        ...userAudit(adminId, userId),
        action: 'ADMIN_USER_VIEWED',
      });
      return detail;
    });
  }
  // The audit row records the change, never the old or new name.
  rename(adminId: string, userId: string, displayName: string, reason: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status::text AS status FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
      if (!rows.length) userNotFound();
      if (rows[0].status === 'DELETED') alreadyDeleted();
      await tx.user.update({
        where: { id: userId },
        data: { displayName },
        select: { id: true },
      });
      await writeAdminAudit(tx, {
        ...userAudit(adminId, userId, reason),
        action: 'ADMIN_USER_RENAMED',
        metadata: { status: rows[0].status },
      });
      return userDetail(tx, userId);
    });
  }
  suspend(adminId: string, userId: string, reason: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await readUser(tx, userId);
      const result = await suspendMember(tx, userId);
      if (result.changed)
        await writeAdminAudit(tx, {
          ...userAudit(adminId, userId, reason),
          action: 'ADMIN_USER_SUSPENDED',
          metadata: {
            previousStatus: result.previousStatus,
            status: 'SUSPENDED',
          },
        });
      return userDetail(tx, userId);
    });
  }
  unsuspend(adminId: string, userId: string, reason: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await readUser(tx, userId);
      await unsuspendMember(tx, userId);
      await writeAdminAudit(tx, {
        ...userAudit(adminId, userId, reason),
        action: 'ADMIN_USER_UNSUSPENDED',
        metadata: { previousStatus: 'SUSPENDED', status: 'ACTIVE' },
      });
      return userDetail(tx, userId);
    });
  }
  // Member account-deletion core without the member's own session/password
  // check: same lock order, ownership preflight, erasure and anonymization.
  async delete(
    adminId: string,
    userId: string,
    reason: string,
    confirmUsername: string
  ) {
    if (
      !(await this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }))
    )
      userNotFound();
    let previousStatus = '';
    await this.deletion.erase(userId, {
      authorize: async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { status: true, username: true },
        });
        if (user.status === 'DELETED') alreadyDeleted();
        if (user.username !== confirmUsername)
          throw new BadRequestException({
            code: 'ADMIN_CONFIRM_USERNAME_MISMATCH',
            message: '확인용 아이디가 회원의 현재 아이디와 달라요.',
          });
        previousStatus = user.status;
      },
      ownedGroupsRemain: (ownership) => {
        throw new ConflictException({
          code: 'ADMIN_OWNED_GROUPS_REMAIN',
          message:
            '회원이 그룹장인 그룹이 있어요. 그룹장을 넘기거나 그룹을 삭제한 뒤 다시 시도해 주세요.',
          groups: ownership.ownedGroups,
          ownedGroupCount: ownership.ownedGroupCount,
        });
      },
      completed: (tx) =>
        writeAdminAudit(tx, {
          ...userAudit(adminId, userId, reason),
          action: 'ADMIN_USER_DELETED',
          metadata: { previousStatus, status: 'DELETED' },
        }),
    });
    return this.prisma.client.$transaction((tx) => userDetail(tx, userId));
  }
}
