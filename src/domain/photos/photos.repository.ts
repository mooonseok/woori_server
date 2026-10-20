import {
  avatarColumns,
  avatarVersionOf,
  type AvatarColumns,
} from '../../common/dto/member-avatar';
import { effectivePhotoDate } from '../memories/memory-date';
import { recordPhotoActivity } from '../notifications/notification-events';
import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { markPhotosDeleted } from './photo-deletion';
import { randomUUID } from 'node:crypto';
import { Prisma, type Photo } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { notBlockedBy, visiblePhotoWhere } from '../blocks/block-visibility';
import type { MediaVariant } from '../../common/media/media-storage.service';
import {
  uploadWindowMs,
  VIDEO_MIMES,
} from '../../common/media/video-transcode';
const RESERVATION = 90n * 1024n * 1024n;
// A video reserves the bounded transcode output (<=150 MB) plus its posters.
const VIDEO_RESERVATION = 200n * 1024n * 1024n;
// Transcoding a minute of video takes far longer than an image: a longer lease.
// Above the sum of the per-step tool timeouts (20 + 240 + 20 + 30 s) plus a
// 200 MB download and the uploads.
const VIDEO_LEASE_MS = 15 * 60_000;
export const isVideoUpload = (mime: string) =>
  (VIDEO_MIMES as readonly string[]).includes(mime);
const variantKind: Record<MediaVariant['kind'], string> = {
  ORIGINAL: 'original',
  DISPLAY: 'preview',
  THUMBNAIL: 'thumbnail',
  VIDEO: 'video',
};
// Every MediaPhoto response names its uploader (withdrawn accounts already
// read '탈퇴한 회원').
export const photoUploader = {
  select: { id: true, nickname: true, ...avatarColumns },
} satisfies Prisma.UserDefaultArgs;
type PhotoUploaderRow = { id: string; nickname: string } & AvatarColumns;
export const photoSummary = {
  id: true,
  groupId: true,
  albumId: true,
  uploaderId: true,
  width: true,
  height: true,
  capturedAt: true,
  manualCapturedDate: true,
  captureDateSource: true,
  createdAt: true,
  status: true,
  mediaKind: true,
  durationMs: true,
  uploader: photoUploader,
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
      // A cursor hidden since (deleted or uploader blocked) is an invalid cursor.
      const anchor = await this.prisma.client.photo.findFirst({
        where: {
          id: cursor,
          groupId,
          albumId,
          ...visiblePhotoWhere(userId),
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
        ...visiblePhotoWhere(userId),
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
              { processingQueuedAt: { not: null } },
              { uploadExpiresAt: { gt: now } },
              { processingUntil: { gt: now } },
            ],
          },
        ],
      };
      if (
        (await tx.photo.count({ where: { ...active, uploaderId: userId } })) >=
        30
      )
        throw new ConflictException({
          code: 'UPLOAD_LIMIT',
          message: '진행 중인 업로드가 끝난 뒤 다시 시도해 주세요.',
        });
      const reserved = await tx.photo.aggregate({
        where: active,
        _sum: { reservedBytes: true },
      });
      const video = isVideoUpload(mime);
      const reservation = video ? VIDEO_RESERVATION : RESERVATION;
      if (
        group.usedBytes + (reserved._sum.reservedBytes ?? 0n) + reservation >
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
          mediaKind: video ? 'VIDEO' : 'PHOTO',
          uploadMime: mime,
          uploadBytes: BigInt(bytes),
          reservedBytes: reservation,
          uploadExpiresAt: new Date(
            now.getTime() + uploadWindowMs(mime, bytes)
          ),
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
        include: { uploader: photoUploader },
      });
      if (!photo) notFound();
      if (photo.status === 'READY') return { ready: true as const, photo };
      // Transcoding never runs inside an API request: videos use the queue.
      if (photo.mediaKind === 'VIDEO')
        throw new ConflictException({
          code: 'VIDEO_QUEUE_REQUIRED',
          message: '동영상은 처리 요청(process)으로 올려 주세요.',
        });
      const now = new Date();
      if (photo.processingQueuedAt)
        throw new ConflictException({ code: 'PHOTO_PROCESSING' });
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
          processingUntil: new Date(now.getTime() + 5 * 60_000),
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
          OR: [
            { processingQueuedAt: null },
            { processingDeadlineAt: { gt: new Date() } },
          ],
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
      // Photos keep their ORIGINAL; videos keep only the transcoded VIDEO
      // (W07-3: the uploaded original is discarded) plus the posters.
      const video = photo.mediaKind === 'VIDEO';
      const original = variants.find(
        (v) => v.kind === (video ? 'VIDEO' : 'ORIGINAL')
      );
      if (
        !original ||
        variants.some((v) => v.kind === (video ? 'ORIGINAL' : 'VIDEO')) ||
        (video && !original.durationMs)
      )
        throw new Error('Primary variant missing');
      await tx.photoVariant.createMany({
        data: variants.map((v) => ({
          photoId,
          kind: variantKind[v.kind],
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
          capturedAt: original.capturedAt ?? null,
          captureDateSource: original.capturedAt ? 'EXIF' : null,
          captureMetadataCheckedAt: new Date(),
          width: original.width,
          height: original.height,
          durationMs: video ? original.durationMs : null,
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
      await recordPhotoActivity(tx, photoId, userId, 'PHOTOS', photoId);
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
  processingSummary(photo: Photo & { uploader: PhotoUploaderRow }) {
    const status =
      photo.status === 'READY'
        ? 'READY'
        : photo.status === 'FAILED'
          ? 'FAILED'
          : 'PROCESSING';
    const phase =
      status !== 'PROCESSING'
        ? status
        : photo.processingToken &&
            photo.processingUntil &&
            photo.processingUntil > new Date()
          ? 'PROCESSING'
          : photo.processingAttempts > 0
            ? 'RETRY_WAIT'
            : 'QUEUED';
    return {
      photoId: photo.id,
      status,
      phase,
      retryAfterSeconds: status === 'PROCESSING' ? 3 : null,
      errorCode: status === 'FAILED' ? photo.processingErrorCode : null,
      ...(status === 'READY' ? { photo: this.summary(photo, true) } : {}),
    };
  }
  async enqueue(
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
        include: { uploader: photoUploader },
      });
      if (!photo) notFound();
      if (photo.processingQueuedAt || photo.status === 'READY')
        return this.processingSummary(photo);
      if (photo.status === 'PROCESSING')
        throw new ConflictException({ code: 'PHOTO_PROCESSING' });
      const now = new Date();
      if (
        photo.status !== 'PENDING' ||
        !photo.uploadExpiresAt ||
        photo.uploadExpiresAt <= now
      )
        throw new GoneException({ code: 'UPLOAD_EXPIRED' });
      return this.processingSummary(
        await tx.photo.update({
          where: { id: photo.id },
          data: {
            status: 'PROCESSING',
            processingQueuedAt: now,
            processingAvailableAt: now,
            processingDeadlineAt: new Date(now.getTime() + 24 * 60 * 60_000),
            processingAttempts: 0,
            processingErrorCode: null,
          },
          include: { uploader: photoUploader },
        })
      );
    });
  }
  async processing(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string
  ) {
    await this.assertAlbum(groupId, albumId, userId);
    const photo = await this.prisma.client.photo.findFirst({
      where: {
        id: photoId,
        groupId,
        albumId,
        uploaderId: userId,
        deletedAt: null,
        processingQueuedAt: { not: null },
        group: memberScope(userId),
        album: { deletedAt: null },
      },
      include: { uploader: photoUploader },
    });
    if (!photo) notFound();
    return this.processingSummary(photo);
  }
  async uploads(
    groupId: string,
    albumId: string,
    userId: string,
    limit: number,
    cursor?: string,
    activeOnly = false
  ) {
    await this.assertAlbum(groupId, albumId, userId);
    const scope: Prisma.PhotoWhereInput = {
      groupId,
      albumId,
      uploaderId: userId,
      deletedAt: null,
      processingQueuedAt: { not: null },
      status: activeOnly
        ? 'PROCESSING'
        : { in: ['PROCESSING', 'READY', 'FAILED'] },
      group: memberScope(userId),
      album: { deletedAt: null },
    };
    let older: Prisma.PhotoWhereInput = {};
    if (cursor) {
      const anchor = await this.prisma.client.photo.findFirst({
        where: { ...scope, id: cursor },
      });
      if (!anchor) notFound();
      older = {
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      };
    }
    const rows = await this.prisma.client.photo.findMany({
      where: { ...scope, ...older },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { uploader: photoUploader },
    });
    const hasNext = rows.length > limit;
    if (hasNext) rows.pop();
    return {
      uploads: rows.map((photo) => this.processingSummary(photo)),
      nextCursor: hasNext ? rows.at(-1)!.id : null,
    };
  }
  // onFailed receives each job this call fails terminally before processing
  // (revoked access, inactive uploader, deadline, attempts) so the worker can
  // remove a video's staging original right away.
  // options.videos=false: a worker without working ffmpeg (or with video
  // processing paused) leaves video jobs to another worker instead of failing them.
  async claimQueued(
    onFailed?: (photo: {
      mediaKind: string;
      stagingKey: string | null;
    }) => void,
    options: { videos?: boolean } = {}
  ) {
    const now = new Date();
    const kinds =
      options.videos === false ? { mediaKind: 'PHOTO' as const } : {};
    const candidates = await this.prisma.client.photo.findMany({
      where: {
        ...kinds,
        status: 'PROCESSING',
        deletedAt: null,
        processingQueuedAt: { not: null },
        processingAvailableAt: { lte: now },
        OR: [{ processingUntil: null }, { processingUntil: { lte: now } }],
      },
      orderBy: [{ processingAvailableAt: 'asc' }, { id: 'asc' }],
      take: 30,
      select: { id: true, groupId: true },
    });
    for (const candidate of candidates) {
      const result = await this.prisma.client.$transaction(async (tx) => {
        const groups = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status FROM woori.groups WHERE id=${candidate.groupId}::uuid FOR UPDATE SKIP LOCKED`;
        if (!groups.length) return null;
        const photo = await tx.photo.findFirst({
          where: {
            ...kinds,
            id: candidate.id,
            status: 'PROCESSING',
            deletedAt: null,
            processingQueuedAt: { not: null },
            processingAvailableAt: { lte: now },
            OR: [{ processingUntil: null }, { processingUntil: { lte: now } }],
          },
        });
        if (!photo) return null;
        const members = await tx.$queryRaw<
          { status: string }[]
        >`SELECT u.status::text AS status FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${photo.groupId}::uuid AND m."userId"=${photo.uploaderId}::uuid AND m.status='ACTIVE' FOR SHARE OF m,u`;
        const album = await tx.album.findFirst({
          where: { id: photo.albumId, groupId: photo.groupId, deletedAt: null },
        });
        // A suspended (non-ACTIVE) uploader's accepted jobs end FAILED so
        // suspension also blocks new shared content.
        const error =
          groups[0].status !== 'ACTIVE' || !members.length || !album
            ? 'UPLOAD_ACCESS_REVOKED'
            : members[0].status !== 'ACTIVE'
              ? 'UPLOADER_INACTIVE'
              : !photo.processingDeadlineAt || photo.processingDeadlineAt <= now
                ? 'UPLOAD_EXPIRED'
                : photo.processingAttempts >= 5
                  ? 'PHOTO_PROCESSING_FAILED'
                  : null;
        if (error) {
          await tx.photo.update({
            where: { id: photo.id },
            data: {
              status: 'FAILED',
              reservedBytes: 0n,
              processingToken: null,
              processingUntil: null,
              processingErrorCode: error,
            },
          });
          return { failed: true as const, photo };
        }
        const token = randomUUID();
        const claimed = await tx.photo.update({
          where: { id: photo.id },
          data: {
            processingToken: token,
            processingUntil: new Date(
              now.getTime() +
                (photo.mediaKind === 'VIDEO' ? VIDEO_LEASE_MS : 5 * 60_000)
            ),
            processingAttempts: { increment: 1 },
          },
        });
        return { failed: false as const, photo: claimed, token };
      });
      if (result?.failed) {
        onFailed?.(result.photo);
        continue;
      }
      if (result) return { photo: result.photo, token: result.token };
    }
    return null;
  }
  async failQueued(
    photoId: string,
    token: string,
    invalid: boolean,
    errorCode?: string
  ) {
    return (await this.failQueuedResult(photoId, token, invalid, errorCode))
      .owned;
  }
  // owned: this attempt still held the lease; terminal: the job is now FAILED
  // (the staging original can then be removed).
  async failQueuedResult(
    photoId: string,
    token: string,
    invalid: boolean,
    errorCode?: string,
    // refundAttempt + immediate: the worker stopped the attempt itself
    // (shutdown drain) and hands it back at once without spending an attempt.
    options: { refundAttempt?: boolean; immediate?: boolean } = {}
  ): Promise<{ owned: boolean; terminal: boolean }> {
    return this.prisma.client.$transaction(async (tx) => {
      const initial = await tx.photo.findUnique({
        where: { id: photoId },
        select: { groupId: true },
      });
      if (!initial) return { owned: false, terminal: false };
      await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${initial.groupId}::uuid FOR UPDATE`;
      const now = new Date();
      const photo = await tx.photo.findFirst({
        where: {
          id: photoId,
          status: 'PROCESSING',
          deletedAt: null,
          processingToken: token,
          processingUntil: { gt: now },
          processingQueuedAt: { not: null },
        },
      });
      if (!photo) return { owned: false, terminal: false };
      const refund = options.refundAttempt === true && !invalid;
      const terminal =
        invalid ||
        (!refund && photo.processingAttempts >= 5) ||
        !photo.processingDeadlineAt ||
        photo.processingDeadlineAt <= now;
      await tx.photo.update({
        where: { id: photoId },
        data: {
          status: terminal ? 'FAILED' : 'PROCESSING',
          processingToken: null,
          processingUntil: null,
          ...(refund && !terminal
            ? { processingAttempts: Math.max(0, photo.processingAttempts - 1) }
            : {}),
          processingAvailableAt: options.immediate
            ? now
            : new Date(
                now.getTime() +
                  Math.min(15 * 60, 15 * 2 ** (photo.processingAttempts - 1)) *
                    1000
              ),
          processingErrorCode: terminal
            ? invalid
              ? (errorCode ?? 'INVALID_PHOTO_FILE')
              : 'PHOTO_PROCESSING_FAILED'
            : null,
          ...(terminal ? { reservedBytes: 0n } : {}),
        },
      });
      return { owned: true, terminal };
    });
  }
  async content(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    kind: string
  ) {
    // Checked before and after the R2 read: a blocked uploader's photo is 404.
    const photo = await this.prisma.client.photo.findFirst({
      where: {
        id: photoId,
        groupId,
        albumId,
        ...visiblePhotoWhere(userId),
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
  // The transcoded MP4 of a READY video the viewer can see (same visibility as
  // content). Photos have no video variant: 404.
  async videoVariant(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string
  ) {
    const photo = await this.prisma.client.photo.findFirst({
      where: {
        id: photoId,
        groupId,
        albumId,
        mediaKind: 'VIDEO',
        ...visiblePhotoWhere(userId),
        group: memberScope(userId),
        album: { deletedAt: null },
      },
      select: {
        durationMs: true,
        variants: {
          where: { kind: 'video' },
          select: {
            objectKey: true,
            mime: true,
            bytes: true,
            width: true,
            height: true,
          },
        },
      },
    });
    const variant = photo?.variants[0];
    if (!photo || !variant || !photo.durationMs) notFound();
    return { ...variant, durationMs: photo.durationMs };
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
      // A photo hidden from this viewer by a personal block is not found, even
      // for the owner (album deletion still removes every photo).
      const photo = await tx.photo.findFirst({
        where: {
          id: photoId,
          albumId,
          groupId,
          uploader: notBlockedBy(userId),
        },
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
  // Keys an attempt wrote that no variant references (it lost its lease to a
  // newer attempt, or publication failed). A lost commit response that did
  // publish them leaves them referenced, so they are never returned.
  async unreferencedKeys(photoId: string, keys: string[]) {
    if (!keys.length) return [];
    const referenced = await this.prisma.client.photoVariant.findMany({
      where: { photoId, objectKey: { in: keys } },
      select: { objectKey: true },
    });
    const used = new Set(referenced.map((variant) => variant.objectKey));
    return keys.filter((key) => !used.has(key));
  }
  async queueDeletedAttempt(photoId: string, keys: string[]) {
    // If deletion won publication, a delayed process may have written after the
    // worker's first sweep. Reset its lease and persist another exact-key sweep.
    await this.prisma.client.$transaction(async (tx) => {
      const initial = await tx.photo.findUnique({
        where: { id: photoId },
        select: { groupId: true },
      });
      if (!initial) return;
      // Serialize late cleanup with group finalization, then recheck the tombstone.
      await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${initial.groupId}::uuid FOR UPDATE`;
      const photo = await tx.photo.findFirst({
        where: { id: photoId, deletedAt: { not: null } },
        select: { id: true },
      });
      if (!photo) return;
      await tx.group.updateMany({
        where: { id: initial.groupId, status: 'DELETED' },
        data: { status: 'DELETING' },
      });
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
      manualCapturedDate?: Date | null;
      createdAt: Date;
      status: string;
      mediaKind: string;
      durationMs: number | null;
      uploader: PhotoUploaderRow;
    },
    canDelete = true
  ) {
    return {
      id: photo.id,
      groupId: photo.groupId,
      albumId: photo.albumId,
      // W07-3: PHOTO or VIDEO (poster via content variants, stream via /video).
      mediaKind: photo.mediaKind,
      durationMs: photo.durationMs,
      width: photo.width,
      height: photo.height,
      capturedAt: photo.capturedAt,
      ...effectivePhotoDate(photo),
      canEditCaptureDate: canDelete,
      createdAt: photo.createdAt,
      status: photo.status,
      canDelete,
      uploader: {
        id: photo.uploader.id,
        displayName: photo.uploader.nickname,
        nickname: photo.uploader.nickname,
        avatarVersion: avatarVersionOf(photo.uploader),
      },
    };
  }
}
