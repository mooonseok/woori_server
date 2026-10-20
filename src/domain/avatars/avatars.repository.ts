import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  AVATAR_SIZES,
  avatarObjectKey,
} from '../../common/media/media-storage.service';
import { notBlockedBySql } from '../blocks/block-visibility';

/** Staging object of an avatar upload (same shape as photo staging keys). */
export const avatarStagingKey = (uploadId: string) => `staging/${uploadId}`;
export const avatarKeys = (folder: string) =>
  AVATAR_SIZES.map((size) => avatarObjectKey(folder, size));
// An abandoned staging object is removed after its signed PUT has expired.
const STAGING_GRACE_MS = 10 * 60_000;
// Renditions written for a completion that never committed are removed later.
const ORPHAN_GRACE_MS = 15 * 60_000;
// Finished upload reservations are kept briefly for support, then purged.
export const AVATAR_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

function uploadNotFound(): never {
  throw new NotFoundException({
    code: 'AVATAR_UPLOAD_NOT_FOUND',
    message: '사진 올리기 시간이 지났어요. 다시 골라 주세요.',
  });
}
async function scheduleCleanup(
  tx: Prisma.TransactionClient,
  userId: string,
  objectKeys: string[],
  availableAt = new Date()
) {
  return tx.storageCleanupJob.create({
    data: { userId, objectKeys, availableAt },
    select: { id: true },
  });
}

/**
 * Account withdrawal: the profile photo goes with the account. Call only inside
 * the account deletion transaction after the user row is locked.
 */
export async function eraseAvatarOnAccountDeletion(
  tx: Prisma.TransactionClient,
  userId: string
) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { avatarKey: true },
  });
  if (user.avatarKey)
    await scheduleCleanup(tx, userId, avatarKeys(user.avatarKey));
  // Pending staging objects already have their own cleanup job.
  await tx.avatarUpload.deleteMany({ where: { userId } });
  await tx.user.update({
    where: { id: userId },
    data: { avatarKey: null, avatarVersion: { increment: 1 } },
  });
}

@Injectable()
export class AvatarsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Reserves a signed upload and schedules removal of its staging object. */
  reserve(userId: string, contentType: string, bytes: number, ttlMs: number) {
    return this.prisma.client.$transaction(async (tx) => {
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + ttlMs);
      await tx.avatarUpload.create({
        data: { id, userId, contentType, bytes, expiresAt },
      });
      await scheduleCleanup(
        tx,
        userId,
        [avatarStagingKey(id)],
        new Date(expiresAt.getTime() + STAGING_GRACE_MS)
      );
      return { id, expiresAt };
    });
  }
  async release(uploadId: string) {
    await this.prisma.client.avatarUpload.deleteMany({
      where: { id: uploadId, completedAt: null },
    });
  }

  /**
   * An open, unexpired upload of this user. The renditions about to be written
   * get a delayed cleanup job that the commit cancels, so a crash between
   * processing and commit leaves nothing behind.
   */
  claim(userId: string, uploadId: string, folder: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const upload = await tx.avatarUpload.findFirst({
        where: {
          id: uploadId,
          userId,
          completedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { contentType: true, bytes: true },
      });
      if (!upload) uploadNotFound();
      const guard = await scheduleCleanup(
        tx,
        userId,
        avatarKeys(folder),
        new Date(Date.now() + ORPHAN_GRACE_MS)
      );
      return { ...upload, guardJobId: guard.id };
    });
  }

  /**
   * Makes the processed folder current: completes the upload once, cancels the
   * orphan guard, bumps the version and schedules the previous renditions.
   * Returns null when the upload was completed concurrently or the account is
   * no longer active (the caller removes what it wrote).
   */
  commit(userId: string, uploadId: string, folder: string, guardJobId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<
        { avatarKey: string | null; status: string }[]
      >`SELECT "avatarKey",status::text AS status FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
      if (user?.status !== 'ACTIVE') return null;
      const completed = await tx.avatarUpload.updateMany({
        where: { id: uploadId, userId, completedAt: null },
        data: { completedAt: new Date() },
      });
      if (completed.count !== 1) return null;
      await tx.storageCleanupJob.updateMany({
        where: { id: guardJobId, userId, completedAt: null },
        data: { completedAt: new Date() },
      });
      if (user.avatarKey)
        await scheduleCleanup(tx, userId, avatarKeys(user.avatarKey));
      return tx.user.update({
        where: { id: userId },
        data: { avatarKey: folder, avatarVersion: { increment: 1 } },
      });
    });
  }

  /** Removes the current photo (idempotent); returns the updated user. */
  remove(userId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<
        { avatarKey: string | null }[]
      >`SELECT "avatarKey" FROM woori.users WHERE id=${userId}::uuid AND status='ACTIVE' FOR UPDATE`;
      if (!user?.avatarKey)
        return tx.user.findUniqueOrThrow({ where: { id: userId } });
      await scheduleCleanup(tx, userId, avatarKeys(user.avatarKey));
      return tx.user.update({
        where: { id: userId },
        data: { avatarKey: null, avatarVersion: { increment: 1 } },
      });
    });
  }

  /**
   * The current avatar folder of `targetId` as `viewerId` may see it: their own,
   * or a member of an active group they both actively belong to whom the
   * viewer has not blocked. Anything else reads as absent.
   */
  async visibleAvatar(viewerId: string, targetId: string) {
    const rows = await this.prisma.client.$queryRaw<
      { avatarKey: string }[]
    >(Prisma.sql`SELECT u."avatarKey" FROM woori.users u
      WHERE u.id=${targetId}::uuid AND u."avatarKey" IS NOT NULL
        AND u.status IN ('ACTIVE','SUSPENDED')
        AND (u.id=${viewerId}::uuid OR (
          ${notBlockedBySql(viewerId, Prisma.sql`u.id`)}
          AND EXISTS (
            SELECT 1 FROM woori.memberships mine
            JOIN woori.groups g ON g.id=mine."groupId" AND g.status='ACTIVE'
            JOIN woori.memberships theirs ON theirs."groupId"=mine."groupId"
              AND theirs."userId"=u.id AND theirs.status='ACTIVE'
            WHERE mine."userId"=${viewerId}::uuid AND mine.status='ACTIVE')))`);
    return rows[0]?.avatarKey ?? null;
  }
}
