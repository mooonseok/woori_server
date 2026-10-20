import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { markPhotosDeleted } from '../photos/photo-deletion';
import { eraseInquiriesOnAccountDeletion } from '../service-support/inquiry-retention';
import { anonymizeReportsOnAccountDeletion } from '../reports/report-retention';
import { eraseBlocksOnAccountDeletion } from '../blocks/block-retention';

class MembershipChanged extends Error {}
export type AccountOwnership = {
  ownedGroups: { id: string; name: string }[];
  ownedGroupCount: number;
  canDelete: boolean;
};
// Caller-specific checks around the shared deletion core. The member path
// verifies its own session and password; the admin path checks the account
// state and confirmation instead. Both throw to roll back.
export interface AccountDeletionHooks {
  // Runs after the account rows are locked (groups → memberships → user →
  // sessions) and before the ownership preflight.
  authorize(tx: Prisma.TransactionClient): Promise<void>;
  ownedGroupsRemain(ownership: AccountOwnership): never;
  // Runs last in the same transaction (e.g. an audit row).
  completed?(tx: Prisma.TransactionClient): Promise<void>;
}
@Injectable()
export class AccountDeletionRepository {
  constructor(private readonly prisma: PrismaService) {}
  findUser(userId: string) {
    return this.prisma.client.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
    });
  }
  private async owned(tx: Prisma.TransactionClient, userId: string) {
    const where = { ownerId: userId, status: 'ACTIVE' as const };
    const ownedGroups = await tx.group.findMany({
      where,
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    const ownedGroupCount = await tx.group.count({ where });
    return { ownedGroups, ownedGroupCount, canDelete: ownedGroupCount === 0 };
  }
  preview(userId: string) {
    return this.prisma.client.$transaction((tx) => this.owned(tx, userId), {
      isolationLevel: 'RepeatableRead',
    });
  }
  private async groupIds(tx: Prisma.TransactionClient, userId: string) {
    return (
      await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.groups WHERE "ownerId"=${userId}::uuid UNION SELECT "groupId" AS id FROM woori.memberships WHERE "userId"=${userId}::uuid UNION SELECT "groupId" AS id FROM woori.photos WHERE "uploaderId"=${userId}::uuid ORDER BY id`
    ).map((row) => row.id);
  }
  delete(userId: string, sessionHash: string, expectedHash: string) {
    return this.erase(userId, {
      authorize: async (tx) => {
        const session = await tx.session.findFirst({
          where: {
            userId,
            tokenHash: sessionHash,
            audience: 'web',
            revokedAt: null,
            expiresAt: { gt: new Date() },
            user: { status: 'ACTIVE', passwordHash: expectedHash },
          },
        });
        if (!session) throw new UnauthorizedException();
      },
      ownedGroupsRemain: (ownership) => {
        throw new ConflictException({
          code: 'ACCOUNT_OWNS_GROUPS',
          message: '그룹장을 넘기거나 그룹 삭제를 요청한 뒤 탈퇴할 수 있어요.',
          ...ownership,
        });
      },
    });
  }
  // Shared account deletion core (member withdrawal and admin deletion): same
  // lock order, same erasure of private data and the same anonymization of
  // shared content. Retries only membership races and deadlocks.
  async erase(userId: string, hooks: AccountDeletionHooks) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.prisma.client.$transaction(
          async (tx) => {
            // Match group mutations: groups -> memberships -> users -> sessions.
            // Recheck the group set after locking the user to fence new joins/groups.
            const groups = await this.groupIds(tx, userId);
            if (groups.length)
              await tx.$queryRaw(
                Prisma.sql`SELECT id FROM woori.groups WHERE id IN (${Prisma.join(groups.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`
              );
            await tx.$queryRaw`SELECT "groupId" FROM woori.memberships WHERE "userId"=${userId}::uuid ORDER BY "groupId" FOR UPDATE`;
            await tx.$queryRaw`SELECT id FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
            if (
              JSON.stringify(groups) !==
              JSON.stringify(await this.groupIds(tx, userId))
            )
              throw new MembershipChanged();
            await tx.$queryRaw`SELECT id FROM woori.sessions WHERE "userId"=${userId}::uuid ORDER BY id FOR UPDATE`;
            await hooks.authorize(tx);
            const ownership = await this.owned(tx, userId);
            if (!ownership.canDelete) hooks.ownedGroupsRemain(ownership);
            for (const groupId of groups)
              await markPhotosDeleted(tx, groupId, {
                uploaderId: userId,
                status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
              });
            const now = new Date();
            await tx.membership.updateMany({
              where: { userId },
              data: { status: 'LEFT' },
            });
            await tx.invitation.updateMany({
              where: { createdById: userId, revokedAt: null },
              data: { revokedAt: now },
            });
            // Fence fanout before deleting its FK targets. No external calls inside
            // this transaction: private data removal and anonymization are atomic.
            await tx.$executeRaw`DELETE FROM woori.outbox_events WHERE type='NOTIFICATION_PUSH' AND "aggregateId" IN (SELECT id FROM woori.notifications WHERE "recipientId"=${userId}::uuid)`;
            await tx.notificationDelivery.deleteMany({
              where: {
                OR: [
                  { notification: { recipientId: userId } },
                  { installation: { userId } },
                ],
              },
            });
            await tx.notificationActivity.deleteMany({
              where: { notification: { recipientId: userId } },
            });
            await tx.notification.deleteMany({
              where: { recipientId: userId },
            });
            await tx.pushInstallation.deleteMany({ where: { userId } });
            // Queued mails (encrypted recipient/token) go with the account.
            await tx.mailOutbox.deleteMany({ where: { userId } });
            await tx.session.deleteMany({ where: { userId } });
            await tx.emailToken.deleteMany({ where: { userId } });
            await tx.notificationPreference.deleteMany({ where: { userId } });
            await tx.groupNotificationPreference.deleteMany({
              where: { userId },
            });
            await tx.photoMemoryPreference.deleteMany({ where: { userId } });
            // Inquiries are personal support records; the policy lives in one place.
            await eraseInquiriesOnAccountDeletion(tx, userId);
            // Filed reports stay for the operator without the reporter's free text.
            await anonymizeReportsOnAccountDeletion(tx, userId);
            // Own blocks are personal settings; blocks on this user are kept.
            await eraseBlocksOnAccountDeletion(tx, userId);
            const tombstone = randomUUID();
            await tx.user.update({
              where: { id: userId },
              data: {
                status: 'DELETED',
                username: `deleted.${tombstone}`,
                email: `${tombstone}@deleted.invalid`,
                displayName: '탈퇴한 회원',
                nickname: '탈퇴한 회원',
                nicknameNeedsUpdate: false,
                passwordHash: '',
                verifiedAt: null,
              },
            });
            await hooks.completed?.(tx);
          },
          { timeout: 30_000 }
        );
        return;
      } catch (error) {
        const known = error instanceof Prisma.PrismaClientKnownRequestError;
        const adapter = known
          ? (error.meta?.driverAdapterError as
              { cause?: { originalCode?: string } } | undefined)
          : undefined;
        const sqlState = known
          ? (error.meta?.code ?? adapter?.cause?.originalCode)
          : undefined;
        const retry =
          error instanceof MembershipChanged ||
          (known &&
            (error.code === 'P2034' ||
              (error.code === 'P2010' &&
                (sqlState === '40P01' || sqlState === '40001'))));
        if (!retry) throw error;
        if (attempt === 3)
          throw new ConflictException({
            code: 'ACCOUNT_DELETION_CONFLICT',
            message:
              '계정의 그룹 정보가 변경됐어요. 잠시 후 다시 확인해 주세요.',
          });
      }
    }
  }
}
