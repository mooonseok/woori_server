import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { writeAdminAudit } from './admin-audit';
import { adminNotFound } from './admin-errors';
export function photoNotFound(): never {
  adminNotFound('ADMIN_PHOTO_NOT_FOUND', '볼 수 있는 사진이 없어요.');
}
export function commentNotFound(): never {
  adminNotFound('ADMIN_COMMENT_NOT_FOUND', '댓글을 찾을 수 없어요.');
}
// Audited operator views of member content (any group, single admin role).
@Injectable()
export class AdminContentRepository {
  constructor(private readonly prisma: PrismaService) {}
  // Only the metadata-stripped display variant ('preview' row), never the
  // original: READY photos, or DELETING photos whose cleanup has not completed.
  async viewablePhoto(photoId: string) {
    const client = this.prisma.client;
    const photo = await client.photo.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        groupId: true,
        status: true,
        deletedAt: true,
        variants: {
          where: { kind: 'preview' },
          select: { objectKey: true, mime: true, bytes: true },
        },
      },
    });
    const variant = photo?.variants[0];
    if (!photo || !variant) photoNotFound();
    let viewable = photo.status === 'READY' && !photo.deletedAt;
    if (!viewable && photo.status === 'DELETING') {
      const job = await client.mediaCleanupJob.findUnique({
        where: { photoId },
        select: { completedAt: true },
      });
      viewable = Boolean(job && !job.completedAt);
    }
    if (!viewable) photoNotFound();
    return {
      id: photo.id,
      groupId: photo.groupId,
      status: photo.status,
      variant,
    };
  }
  // The transcoded MP4 of a viewable video (same READY/DELETING-before-cleanup
  // rule as the poster). The uploaded original is never stored.
  async viewableVideo(photoId: string) {
    const client = this.prisma.client;
    const photo = await client.photo.findUnique({
      where: { id: photoId },
      select: {
        id: true,
        groupId: true,
        status: true,
        deletedAt: true,
        mediaKind: true,
        durationMs: true,
        variants: {
          where: { kind: 'video' },
          select: { objectKey: true, mime: true, bytes: true },
        },
      },
    });
    const variant = photo?.variants[0];
    if (!photo || photo.mediaKind !== 'VIDEO' || !variant) photoNotFound();
    let viewable = photo.status === 'READY' && !photo.deletedAt;
    if (!viewable && photo.status === 'DELETING') {
      const job = await client.mediaCleanupJob.findUnique({
        where: { photoId },
        select: { completedAt: true },
      });
      viewable = Boolean(job && !job.completedAt);
    }
    if (!viewable) photoNotFound();
    return {
      id: photo.id,
      groupId: photo.groupId,
      durationMs: photo.durationMs,
      variant,
    };
  }
  async auditVideoView(
    adminId: string,
    photo: { id: string; groupId: string },
    reason: string
  ) {
    await this.prisma.client.$transaction((tx) =>
      writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_VIDEO_VIEWED',
        targetType: 'PHOTO',
        targetId: photo.id,
        reason,
        metadata: { photoId: photo.id, groupId: photo.groupId },
      })
    );
  }
  async auditPhotoView(
    adminId: string,
    photo: { id: string; groupId: string },
    reason: string
  ) {
    await this.prisma.client.$transaction((tx) =>
      writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_PHOTO_VIEWED',
        targetType: 'PHOTO',
        targetId: photo.id,
        reason,
        metadata: { photoId: photo.id, groupId: photo.groupId },
      })
    );
  }
  // Includes soft-deleted comments (the body is retained for the operator).
  viewComment(adminId: string, commentId: string, reason: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const comment = await tx.comment.findUnique({
        where: { id: commentId },
        select: {
          id: true,
          groupId: true,
          photoId: true,
          kind: true,
          body: true,
          x: true,
          y: true,
          createdAt: true,
          deletedAt: true,
          author: { select: { id: true, displayName: true } },
        },
      });
      if (!comment) commentNotFound();
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_COMMENT_VIEWED',
        targetType: 'COMMENT',
        targetId: comment.id,
        reason,
        metadata: {
          commentId: comment.id,
          photoId: comment.photoId,
          groupId: comment.groupId,
        },
      });
      const { groupId: _groupId, ...result } = comment;
      return result;
    });
  }
}
