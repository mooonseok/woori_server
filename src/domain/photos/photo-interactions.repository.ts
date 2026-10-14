import { recordPhotoActivity } from '../notifications/notification-events';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { notFound } from './photos.repository';
import {
  REACTION_EMOJIS,
  type CreateCommentDto,
} from './dto/photo-interactions.dto';
const commentSelect = {
  id: true,
  photoId: true,
  authorId: true,
  body: true,
  kind: true,
  x: true,
  y: true,
  createdAt: true,
  author: { select: { id: true, displayName: true } },
} satisfies Prisma.CommentSelect;
type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;
function commentNotFound(): never {
  throw new NotFoundException({
    code: 'COMMENT_NOT_FOUND',
    message: '댓글을 찾을 수 없거나 변경할 권한이 없어요.',
  });
}
export function commentSummary(
  comment: CommentRow,
  userId: string,
  owner: boolean
) {
  const { authorId, ...result } = comment;
  return {
    ...result,
    canEdit: authorId === userId,
    canDelete: authorId === userId || owner,
  };
}
@Injectable()
export class PhotoInteractionsRepository {
  constructor(private readonly prisma: PrismaService) {}
  private async withPhoto<T>(
    photoId: string,
    userId: string,
    operation: (
      tx: Prisma.TransactionClient,
      groupId: string,
      owner: boolean
    ) => Promise<T>
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const photo = await tx.photo.findUnique({
        where: { id: photoId },
        select: { groupId: true, albumId: true },
      });
      if (!photo) notFound();
      // Match media deletion's group -> membership -> photo lock order.
      // Shared locks hold access valid until reads/writes commit, including direct revocation.
      const groups = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.groups WHERE id=${photo.groupId}::uuid AND status='ACTIVE' FOR SHARE`;
      if (!groups.length) notFound();
      const members = await tx.$queryRaw<
        { role: string }[]
      >`SELECT m.role FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${photo.groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,u`;
      if (!members.length) notFound();
      const albums = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.albums WHERE id=${photo.albumId}::uuid AND "groupId"=${photo.groupId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
      if (!albums.length) notFound();
      const photos = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.photos WHERE id=${photoId}::uuid AND "groupId"=${photo.groupId}::uuid AND "albumId"=${photo.albumId}::uuid AND status='READY' AND "deletedAt" IS NULL FOR SHARE`;
      if (!photos.length) notFound();
      return operation(tx, photo.groupId, members[0].role === 'OWNER');
    });
  }
  listComments(
    photoId: string,
    userId: string,
    limit: number,
    cursor?: string
  ) {
    return this.withPhoto(photoId, userId, async (tx, groupId, owner) => {
      // A soft-deleted cursor remains a valid anchor in this same photo.
      if (
        cursor &&
        !(await tx.comment.findFirst({
          where: { id: cursor, photoId, groupId },
          select: { id: true },
        }))
      )
        commentNotFound();
      const where = { photoId, groupId, deletedAt: null };
      // Compare the original PostgreSQL timestamp/id tuple without JavaScript
      // millisecond truncation. An excluded soft-deleted anchor must not cause
      // ORM cursor skip:1 to discard the next visible comment.
      const afterCursor = cursor
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT c.id FROM woori.comments c
            WHERE c."photoId"=${photoId}::uuid AND c."groupId"=${groupId}::uuid
              AND c."deletedAt" IS NULL
              AND (c."createdAt",c.id) < (
                SELECT "createdAt",id FROM woori.comments
                WHERE id=${cursor}::uuid AND "photoId"=${photoId}::uuid
              )
            ORDER BY c."createdAt" DESC,c.id DESC LIMIT ${limit + 1}`
        : undefined;
      const comments = await tx.comment.findMany({
        where: {
          ...where,
          ...(afterCursor
            ? { id: { in: afterCursor.map((row) => row.id) } }
            : {}),
        },
        select: commentSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const hasNext = comments.length > limit;
      if (hasNext) comments.pop();
      return {
        comments: comments.map((comment) =>
          commentSummary(comment, userId, owner)
        ),
        nextCursor: hasNext ? comments.at(-1)!.id : null,
        total: await tx.comment.count({ where }),
      };
    });
  }
  createComment(photoId: string, userId: string, dto: CreateCommentDto) {
    return this.withPhoto(photoId, userId, async (tx, groupId, owner) => {
      const comment = await tx.comment.create({
        data: {
          photoId,
          groupId,
          authorId: userId,
          body: dto.body,
          kind: dto.kind,
          x: dto.x,
          y: dto.y,
        },
        select: commentSelect,
      });
      await recordPhotoActivity(
        tx,
        photoId,
        userId,
        dto.kind === 'PIN' ? 'PIN' : 'COMMENT',
        comment.id
      );
      return { comment: commentSummary(comment, userId, owner) };
    });
  }
  editComment(
    photoId: string,
    commentId: string,
    userId: string,
    body: string
  ) {
    return this.withPhoto(photoId, userId, async (tx, groupId, owner) => {
      await tx.$queryRaw`SELECT id FROM woori.comments WHERE id=${commentId}::uuid AND "photoId"=${photoId}::uuid FOR UPDATE`;
      const comment = await tx.comment.findFirst({
        where: {
          id: commentId,
          photoId,
          groupId,
          authorId: userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!comment) commentNotFound();
      const updated = await tx.comment.update({
        where: { id: commentId },
        data: { body },
        select: commentSelect,
      });
      return { comment: commentSummary(updated, userId, owner) };
    });
  }
  deleteComment(photoId: string, commentId: string, userId: string) {
    return this.withPhoto(photoId, userId, async (tx, groupId, owner) => {
      await tx.$queryRaw`SELECT id FROM woori.comments WHERE id=${commentId}::uuid AND "photoId"=${photoId}::uuid FOR UPDATE`;
      const comment = await tx.comment.findFirst({
        where: {
          id: commentId,
          photoId,
          groupId,
          ...(owner ? {} : { authorId: userId }),
        },
        select: { id: true, deletedAt: true },
      });
      if (!comment) commentNotFound();
      if (!comment.deletedAt)
        await tx.comment.update({
          where: { id: commentId },
          data: { deletedAt: new Date() },
        });
    });
  }
  private async reactionSummary(
    tx: Prisma.TransactionClient,
    photoId: string,
    userId: string
  ) {
    // Counts and the actor's selection use one MVCC snapshot under concurrent
    // changes, so myReaction can never contradict its response's aggregate.
    const counts = await tx.$queryRaw<
      { emoji: string; count: bigint; mine: boolean }[]
    >`
      SELECT emoji,COUNT(*) AS count,BOOL_OR("userId"=${userId}::uuid) AS mine
      FROM woori.reactions WHERE "photoId"=${photoId}::uuid GROUP BY emoji`;
    const reactions = REACTION_EMOJIS.flatMap((emoji) => {
      const count = Number(
        counts.find((entry) => entry.emoji === emoji)?.count ?? 0n
      );
      return count ? [{ emoji, count }] : [];
    });
    return {
      reactions,
      myReaction: counts.find((entry) => entry.mine)?.emoji ?? null,
      total: reactions.reduce((total, item) => total + item.count, 0),
    };
  }
  getReactions(photoId: string, userId: string) {
    return this.withPhoto(photoId, userId, (tx) =>
      this.reactionSummary(tx, photoId, userId)
    );
  }
  setReaction(photoId: string, userId: string, emoji: string | null) {
    return this.withPhoto(photoId, userId, async (tx) => {
      if (emoji === null)
        await tx.reaction.deleteMany({ where: { photoId, userId } });
      else
        await tx.reaction.upsert({
          where: { photoId_userId: { photoId, userId } },
          create: { photoId, userId, emoji },
          update: { emoji },
        });
      if (emoji !== null)
        await recordPhotoActivity(tx, photoId, userId, 'REACTION', photoId);
      return this.reactionSummary(tx, photoId, userId);
    });
  }
}
