import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { eraseNotificationsFromActor } from '../notifications/notification-erasure';
import { BLOCK_LIMIT } from './block-policy';
export function userNotFound(): never {
  throw new NotFoundException({
    code: 'USER_NOT_FOUND',
    message: '회원을 찾을 수 없어요.',
  });
}
// A user is blockable only when the blocker can currently see them: a shared
// active group with both memberships active (the target ACTIVE or SUSPENDED, as
// in the group roster), or retained content (READY photo,
// non-deleted comment, reaction on a READY photo) in an active group where the
// blocker is an active member. This also covers withdrawn or departed authors and
// prevents enumerating arbitrary ids.
function visibleUser(blockerId: string, targetId: string) {
  const blockerGroup = (alias: string) =>
    Prisma.sql`JOIN woori.groups g ON g.id=${Prisma.raw(alias)}."groupId" AND g.status='ACTIVE' JOIN woori.memberships mb ON mb."groupId"=g.id AND mb."userId"=${blockerId}::uuid AND mb.status='ACTIVE'`;
  return Prisma.sql`SELECT u.id FROM woori.users u WHERE u.id=${targetId}::uuid AND (
    (u.status IN ('ACTIVE','SUSPENDED') AND EXISTS (SELECT 1 FROM woori.memberships mt ${blockerGroup('mt')} WHERE mt."userId"=u.id AND mt.status='ACTIVE'))
    OR EXISTS (SELECT 1 FROM woori.photos p ${blockerGroup('p')} WHERE p."uploaderId"=u.id AND p.status='READY' AND p."deletedAt" IS NULL)
    OR EXISTS (SELECT 1 FROM woori.comments c JOIN woori.photos p ON p.id=c."photoId" AND p.status='READY' AND p."deletedAt" IS NULL ${blockerGroup('c')} WHERE c."authorId"=u.id AND c."deletedAt" IS NULL)
    OR EXISTS (SELECT 1 FROM woori.reactions r JOIN woori.photos p ON p.id=r."photoId" AND p.status='READY' AND p."deletedAt" IS NULL ${blockerGroup('p')} WHERE r."userId"=u.id)
  )`;
}
type BlockRow = { userId: string; displayName: string; blockedAt: Date };
@Injectable()
export class BlocksRepository {
  constructor(private readonly prisma: PrismaService) {}
  block(blockerId: string, blockedId: string, tokenHash: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const key = { blockerId_blockedId: { blockerId, blockedId } };
      // Idempotent: an existing block is returned as is (it is the caller's own
      // row, so this reveals nothing about arbitrary ids).
      const current = await tx.userBlock.findUnique({
        where: key,
        include: { blocked: { select: { displayName: true } } },
      });
      if (current)
        return {
          userId: blockedId,
          displayName: current.blocked.displayName,
          blockedAt: current.createdAt,
        };
      if (
        !(
          await tx.$queryRaw<{ id: string }[]>(
            visibleUser(blockerId, blockedId)
          )
        ).length
      )
        userNotFound();
      // No group/membership row locks are taken. Users are locked in id order,
      // then the session, matching credential changes and account deletion:
      // a block cannot be stored for an account whose withdrawal committed.
      const ids = [blockerId, blockedId].sort();
      const users = await tx.$queryRaw<
        { id: string; status: string; displayName: string }[]
      >(
        Prisma.sql`SELECT id,status,"displayName" FROM woori.users WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`
      );
      const blocker = users.find((user) => user.id === blockerId);
      const target = users.find((user) => user.id === blockedId);
      if (blocker?.status !== 'ACTIVE') throw new UnauthorizedException();
      const sessions = await tx.$queryRaw<
        { id: string }[]
      >`SELECT s.id FROM woori.sessions s WHERE s."userId"=${blockerId}::uuid AND s."tokenHash"=${tokenHash} AND s.audience='web' AND s."revokedAt" IS NULL AND s."expiresAt">now() FOR SHARE OF s`;
      if (!sessions.length) throw new UnauthorizedException();
      if (!target) userNotFound();
      // Serializes this blocker's additions so the limit cannot be overshot.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user-block:${blockerId}`}, 0))`;
      const existing = await tx.userBlock.findUnique({ where: key });
      if (existing)
        return {
          userId: blockedId,
          displayName: target.displayName,
          blockedAt: existing.createdAt,
        };
      if ((await tx.userBlock.count({ where: { blockerId } })) >= BLOCK_LIMIT)
        throw new ConflictException({
          code: 'BLOCK_LIMIT_REACHED',
          message: `차단은 최대 ${BLOCK_LIMIT}명까지 할 수 있어요.`,
        });
      const created = await tx.userBlock.create({
        data: { blockerId, blockedId },
      });
      // Unblocking restores content visibility only, not missed notifications.
      await eraseNotificationsFromActor(tx, blockerId, blockedId);
      return {
        userId: blockedId,
        displayName: target.displayName,
        blockedAt: created.createdAt,
      };
    });
  }
  // Same lock order as block(): users (id order) -> per-blocker advisory lock.
  // A notification from the blocked user that raced the block (created while the
  // block was being stored) is erased before the row goes, so unblocking never
  // resurrects it. Not blocked: nothing is erased.
  unblock(blockerId: string, blockedId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const ids = [blockerId, blockedId].sort();
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM woori.users WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`
      );
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`user-block:${blockerId}`}, 0))`;
      const key = { blockerId_blockedId: { blockerId, blockedId } };
      if (!(await tx.userBlock.findUnique({ where: key }))) return;
      await eraseNotificationsFromActor(tx, blockerId, blockedId);
      await tx.userBlock.delete({ where: key });
    });
  }
  list(blockerId: string, limit: number, cursor?: string) {
    return this.prisma.client.$transaction(
      async (tx) => {
        if (
          cursor &&
          !(await tx.userBlock.findUnique({
            where: { blockerId_blockedId: { blockerId, blockedId: cursor } },
            select: { blockedId: true },
          }))
        )
          userNotFound();
        const after = cursor
          ? Prisma.sql`AND (b."createdAt",b."blockedId")<(SELECT "createdAt","blockedId" FROM woori.user_blocks WHERE "blockerId"=${blockerId}::uuid AND "blockedId"=${cursor}::uuid)`
          : Prisma.empty;
        const rows = await tx.$queryRaw<BlockRow[]>(
          Prisma.sql`SELECT b."blockedId" AS "userId",u."displayName",b."createdAt" AS "blockedAt" FROM woori.user_blocks b JOIN woori.users u ON u.id=b."blockedId" WHERE b."blockerId"=${blockerId}::uuid ${after} ORDER BY b."createdAt" DESC,b."blockedId" DESC LIMIT ${limit + 1}`
        );
        const more = rows.length > limit;
        if (more) rows.pop();
        return { items: rows, nextCursor: more ? rows.at(-1)!.userId : null };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
}
