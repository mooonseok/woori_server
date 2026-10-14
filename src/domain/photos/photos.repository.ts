import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { markPhotosDeleted } from './photo-deletion';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import type { MediaVariant } from '../../common/media/media-storage.service';
const RESERVATION = 90n * 1024n * 1024n;
export const photoSummary = {
  id: true,
  groupId: true,
  albumId: true,
  uploaderId: true,
  width: true,
  height: true,
  capturedAt: true,
  createdAt: true,
  status: true,
} satisfies Prisma.PhotoSelect;
export function notFound(): never {
  throw new NotFoundException({
    code: 'PHOTO_NOT_FOUND',
    message: '사진 또는 앨범을 찾을 수 없어요.',
  });
}
const memberScope = (userId: string) => ({
  status: 'ACTIVE' as const,
  memberships: {
    some: {
      userId,
      status: 'ACTIVE' as const,
      user: { status: 'ACTIVE' as const },
    },
  },
});
@Injectable()
export class PhotosRepository {
  constructor(private readonly prisma: PrismaService) {}
  private async lockAlbum(
    tx: Prisma.TransactionClient,
    groupId: string,
    albumId: string,
    userId: string
  ) {
    // Serialize reservations/accounting in this group, without holding a transaction during R2 I/O.
    const groups = await tx.$queryRaw<
      { quotaBytes: bigint; usedBytes: bigint }[]
    >`SELECT "quotaBytes","usedBytes" FROM woori.groups WHERE id=${groupId}::uuid AND status='ACTIVE' FOR UPDATE`;
    if (!groups.length) notFound();
    const memberships = await tx.$queryRaw<
      { groupId: string }[]
    >`SELECT m."groupId" FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,u`;
    if (!memberships.length) notFound();
    if (
      !(await tx.album.findFirst({
        where: { id: albumId, groupId, deletedAt: null },
      }))
    )
      notFound();
    return groups[0];
  }
  async assertAlbum(groupId: string, albumId: string, userId: string) {
    if (
      !(await this.prisma.client.album.findFirst({
        where: {
          id: albumId,
          groupId,
          deletedAt: null,
          group: memberScope(userId),
        },
        select: { id: true },
      }))
    )
      notFound();
  }
  async list(
    groupId: string,
    albumId: string,
    userId: string,
    limit: number,
    cursor?: string
  ) {
    await this.assertAlbum(groupId, albumId, userId);
    let older: Prisma.PhotoWhereInput = {};
    if (cursor) {
      const anchor = await this.prisma.client.photo.findFirst({
        where: {
          id: cursor,
          groupId,
          albumId,
          status: 'READY',
          deletedAt: null,
          group: memberScope(userId),
        },
        select: { id: true, createdAt: true },
      });
      if (!anchor) notFound();
      older = {
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      };
    }
    const photos = await this.prisma.client.photo.findMany({
      where: {
        groupId,
        albumId,
        status: 'READY',
        deletedAt: null,
        group: memberScope(userId),
        album: { deletedAt: null },
        ...older,
      },
      select: photoSummary,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasNext = photos.length > limit;
    if (hasNext) photos.pop();
    const membership = await this.prisma.client.membership.findFirst({
      where: {
        groupId,
        userId,
        status: 'ACTIVE',
        user: { status: 'ACTIVE' },
        group: { status: 'ACTIVE' },
      },
      select: { role: true },
    });
    if (!membership) notFound();
    return {
      photos: photos.map((photo) =>
        this.summary(
          photo,
          membership.role === 'OWNER' || photo.uploaderId === userId
        )
      ),
      nextCursor: hasNext ? photos.at(-1)!.id : null,
    };
  }
  async reserve(
    groupId: string,
    albumId: string,
    userId: string,
    mime: string,
    bytes: number
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const group = await this.lockAlbum(tx, groupId, albumId, userId);
      const now = new Date();
      const active = {
        groupId,
        deletedAt: null,
        OR: [
          { status: 'PENDING' as const, uploadExpiresAt: { gt: now } },
          {
            status: 'PROCESSING' as const,
            OR: [
              { uploadExpiresAt: { gt: now } },
              { processingUntil: { gt: now } },
            ],
          },
        ],
      };
      if (
        (await tx.photo.count({ where: { ...active, uploaderId: userId } })) >=
        5
      )
        throw new ConflictException({
          code: 'UPLOAD_LIMIT',
          message: '진행 중인 업로드가 끝난 뒤 다시 시도해 주세요.',
        });
      const reserved = await tx.photo.aggregate({
        where: active,
        _sum: { reservedBytes: true },
      });
      if (
        group.usedBytes + (reserved._sum.reservedBytes ?? 0n) + RESERVATION >
        group.quotaBytes
      )
        throw new ConflictException({
          code: 'STORAGE_QUOTA_EXCEEDED',
          message: '그룹 저장 공간이 부족해요.',
        });
      return tx.photo.create({
        data: {
          groupId,
          albumId,
          uploaderId: userId,
          stagingKey: `staging/${randomUUID()}`,
          uploadMime: mime,
          uploadBytes: BigInt(bytes),
          reservedBytes: RESERVATION,
          uploadExpiresAt: new Date(now.getTime() + 10 * 60_000),
        },
      });
    });
  }
  async claim(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.lockAlbum(tx, groupId, albumId, userId);
      const photo = await tx.photo.findFirst({
        where: {
          id: photoId,
          groupId,
          albumId,
          uploaderId: userId,
          deletedAt: null,
        },
      });
      if (!photo) notFound();
      if (photo.status === 'READY') return { ready: true as const, photo };
      const now = new Date();
      if (
        photo.status === 'PROCESSING' &&
        photo.processingUntil &&
        photo.processingUntil > now
      )
        throw new ConflictException({
          code: 'PHOTO_PROCESSING',
          message: '사진을 처리 중이에요. 잠시 후 다시 시도해 주세요.',
        });
      if (
        !['PENDING', 'PROCESSING'].includes(photo.status) ||
        !photo.uploadExpiresAt ||
        photo.uploadExpiresAt <= now
      )
        throw new GoneException({
          code: 'UPLOAD_EXPIRED',
          message: '업로드가 만료됐어요. 사진을 다시 선택해 주세요.',
        });
      const token = randomUUID();
      const claimed = await tx.photo.update({
        where: { id: photoId },
        data: {
          status: 'PROCESSING',
          processingToken: token,
          processingUntil: new Date(now.getTime() + 120_000),
        },
      });
      return { ready: false as const, photo: claimed, token };
    });
  }
  async finish(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    token: string,
    variants: MediaVariant[]
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.lockAlbum(tx, groupId, albumId, userId);
      const photo = await tx.photo.findFirst({
        where: {
          id: photoId,
          groupId,
          albumId,
          uploaderId: userId,
          status: 'PROCESSING',
          deletedAt: null,
          processingToken: token,
          processingUntil: { gt: new Date() },
        },
      });
      if (!photo)
        throw new ConflictException({
          code: 'PHOTO_PROCESSING',
          message: '사진 처리 상태가 변경됐어요. 다시 확인해 주세요.',
        });
      const bytes = variants.reduce((sum, v) => sum + BigInt(v.bytes), 0n);
      if (bytes > photo.reservedBytes)
        throw new ConflictException({
          code: 'PHOTO_TOO_LARGE',
          message: '처리된 사진이 너무 커요.',
        });
      const original = variants.find((v) => v.kind === 'ORIGINAL');
      if (!original) throw new Error('Original variant missing');
      await tx.photoVariant.createMany({
        data: variants.map((v) => ({
          photoId,
          kind: v.kind === 'DISPLAY' ? 'preview' : v.kind.toLowerCase(),
          objectKey: v.objectKey,
          mime: v.mime,
          width: v.width,
          height: v.height,
          bytes: BigInt(v.bytes),
        })),
      });
      const result = await tx.photo.update({
        where: { id: photoId },
        data: {
          status: 'READY',
          bytes,
          width: original.width,
          height: original.height,
          reservedBytes: 0n,
          processingToken: null,
          processingUntil: null,
          // Retain the private staging key for deletion after signed PUT expiry.
        },
        select: photoSummary,
      });
      await tx.group.update({
        where: { id: groupId },
        data: { usedBytes: { increment: bytes } },
      });
      return this.summary(result, true);
    });
  }
  async release(photoId: string, token: string | undefined, failed: boolean) {
    const result = await this.prisma.client.photo.updateMany({
      where: {
        id: photoId,
        deletedAt: null,
        ...(token
          ? { status: 'PROCESSING', processingToken: token }
          : { status: 'PENDING' }),
      },
      data: {
        status: failed ? 'FAILED' : 'PENDING',
        processingToken: null,
        processingUntil: null,
        ...(failed ? { reservedBytes: 0n } : {}),
      },
    });
    return result.count;
  }
  async content(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    kind: string
  ) {
    const photo = await this.prisma.client.photo.findFirst({
      where: {
        id: photoId,
        groupId,
        albumId,
        status: 'READY',
        deletedAt: null,
        group: memberScope(userId),
        album: { deletedAt: null },
      },
      select: {
        variants: {
          where: { kind: kind === 'DISPLAY' ? 'preview' : kind.toLowerCase() },
          select: { objectKey: true, mime: true, bytes: true },
        },
      },
    });
    const variant = photo?.variants[0];
    if (!variant) notFound();
    return variant;
  }

  async remove(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string
  ) {
    await this.prisma.client.$transaction(async (tx) => {
      await this.lockAlbum(tx, groupId, albumId, userId);
      const membership = await tx.membership.findUnique({
        where: { groupId_userId: { groupId, userId } },
        select: { role: true },
      });
      const photo = await tx.photo.findFirst({
        where: { id: photoId, albumId, groupId },
      });
      if (
        !photo ||
        (photo.uploaderId !== userId && membership?.role !== 'OWNER')
      )
        notFound();
      if (photo.deletedAt) return;
      await markPhotosDeleted(tx, groupId, { albumId, id: photoId });
    });
  }
  async queueDeletedAttempt(photoId: string, keys: string[]) {
    // If deletion won publication, a delayed process may have written after the
    // worker's first sweep. Reset its lease and persist another exact-key sweep.
    await this.prisma.client.$transaction(async (tx) => {
      const photo = await tx.photo.findFirst({
        where: { id: photoId, deletedAt: { not: null } },
        select: { id: true },
      });
      if (!photo) return;
      await tx.$queryRaw`SELECT id FROM woori.media_cleanup_jobs WHERE "photoId"=${photoId}::uuid FOR UPDATE`;
      const job = await tx.mediaCleanupJob.findUnique({ where: { photoId } });
      if (!job) throw new Error('Deleted photo has no cleanup job');
      await tx.mediaCleanupJob.update({
        where: { photoId },
        data: {
          objectKeys: Array.from(new Set([...job.objectKeys, ...keys])),
          completedAt: null,
          lockedUntil: null,
          lockToken: null,
          availableAt: new Date(
            Math.max(Date.now(), job.availableAt.getTime())
          ),
        },
      });
      await tx.photo.update({
        where: { id: photoId },
        data: { status: 'DELETING' },
      });
    });
  }
  summary(
    photo: {
      id: string;
      groupId: string;
      albumId: string;
      width: number | null;
      height: number | null;
      capturedAt: Date | null;
      createdAt: Date;
      status: string;
    },
    canDelete = true
  ) {
    return {
      id: photo.id,
      groupId: photo.groupId,
      albumId: photo.albumId,
      width: photo.width,
      height: photo.height,
      capturedAt: photo.capturedAt,
      createdAt: photo.createdAt,
      status: photo.status,
      canDelete,
    };
  }
}
