import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { markPhotosDeleted } from '../photos/photo-deletion';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { notBlockedBySql } from '../blocks/block-visibility';
import { effectivePhotoDateSql } from '../photos/photo-date-sql';
export type AlbumStats = {
  // Visible media (photos and videos); videoCount of them are videos (W07-3).
  photoCount: number;
  videoCount: number;
  coverPhotoId: string | null;
  // PHOTO or VIDEO of the cover item (play badge without loading the album).
  coverMediaKind: 'PHOTO' | 'VIDEO' | null;
  // Korea calendar dates (YYYY-MM-DD) of the earliest/latest effective taken
  // date among the viewer's visible photos; null when none is visible.
  startDate: string | null;
  endDate: string | null;
};
const EMPTY_STATS: AlbumStats = {
  photoCount: 0,
  videoCount: 0,
  coverPhotoId: null,
  coverMediaKind: null,
  startDate: null,
  endDate: null,
};
export function albumCursorInvalid(): never {
  throw new BadRequestException({
    code: 'ALBUM_CURSOR_INVALID',
    message: '앨범 목록을 처음부터 다시 불러와 주세요.',
  });
}
// Count, auto cover and date range of the given albums in ONE grouped query
// (no per-album queries). Same visibility as photo lists: READY, not deleted,
// uploader not blocked by the viewer. Videos (W07-3) are rows of the same table,
// so count, cover (their poster) and range include them in the same query.
export async function albumStats(
  tx: Prisma.TransactionClient,
  groupId: string,
  viewerId: string,
  albumIds: string[]
) {
  const stats = new Map<string, AlbumStats>();
  if (!albumIds.length) return stats;
  const rows = await tx.$queryRaw<({ albumId: string } & AlbumStats)[]>(
    Prisma.sql`SELECT p."albumId",COUNT(*)::int AS "photoCount",COUNT(*) FILTER (WHERE p."mediaKind"='VIDEO')::int AS "videoCount",
      (array_agg(p.id ORDER BY p."createdAt" DESC,p.id DESC))[1] AS "coverPhotoId",
      (array_agg(p."mediaKind"::text ORDER BY p."createdAt" DESC,p.id DESC))[1] AS "coverMediaKind",
      to_char(MIN(${effectivePhotoDateSql}),'YYYY-MM-DD') AS "startDate",
      to_char(MAX(${effectivePhotoDateSql}),'YYYY-MM-DD') AS "endDate"
    FROM woori.photos p
    WHERE p."groupId"=${groupId}::uuid AND p."albumId" IN (${Prisma.join(albumIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND p.status='READY' AND p."deletedAt" IS NULL
      AND ${notBlockedBySql(viewerId, Prisma.sql`p."uploaderId"`)}
    GROUP BY p."albumId"`
  );
  for (const { albumId, ...row } of rows) stats.set(albumId, row);
  return stats;
}
@Injectable()
export class AlbumsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async create(groupId: string, userId: string, title: string) {
    return this.prisma.client.$transaction(async (tx) => {
      // Match the group-first order used by ownership/removal and upload publication.
      await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${groupId}::uuid AND status='ACTIVE' FOR SHARE`;
      const rows = await tx.$queryRaw<
        { groupId: string; role: string }[]
      >`SELECT m."groupId",m.role FROM woori.memberships m JOIN woori.groups g ON g.id=m."groupId" JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND g.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,g,u`;
      if (!rows.length)
        throw new NotFoundException({
          code: 'GROUP_NOT_FOUND',
          message: '그룹을 찾을 수 없어요.',
        });
      const album = await tx.album.create({
        data: { groupId, creatorId: userId, title },
        select: { id: true, groupId: true, title: true, createdAt: true },
      });
      return {
        ...album,
        ...EMPTY_STATS,
        canManage: rows[0].role === 'OWNER',
      };
    });
  }
  // Newest-created first, ties by id. The cursor is the last album's id (opaque
  // to clients): malformed, unknown, deleted or another group's -> 400
  // ALBUM_CURSOR_INVALID so the client restarts from the first page. Albums
  // created after the first page sort before the cursor, so later pages never
  // repeat or skip an album.
  list(groupId: string, userId: string, limit: number, cursor?: unknown) {
    return this.prisma.client.$transaction(
      async (tx) => {
        const membership = await tx.membership.findFirst({
          where: {
            groupId,
            userId,
            status: 'ACTIVE',
            user: { status: 'ACTIVE' },
            group: { status: 'ACTIVE' },
          },
          select: { role: true },
        });
        if (!membership)
          throw new NotFoundException({
            code: 'GROUP_NOT_FOUND',
            message: '그룹을 찾을 수 없어요.',
          });
        let after = Prisma.empty;
        if (cursor !== undefined) {
          if (typeof cursor !== 'string' || !isUUID(cursor))
            albumCursorInvalid();
          const anchor = await tx.album.findFirst({
            where: { id: cursor, groupId, deletedAt: null },
            select: { id: true },
          });
          if (!anchor) albumCursorInvalid();
          // Compare against the stored microsecond timestamp, not a JS Date copy.
          after = Prisma.sql`AND (a."createdAt",a.id)<(SELECT c."createdAt",c.id FROM woori.albums c WHERE c.id=${cursor}::uuid)`;
        }
        const albums = await tx.$queryRaw<
          { id: string; groupId: string; title: string; createdAt: Date }[]
        >(
          Prisma.sql`SELECT a.id,a."groupId",a.title,a."createdAt" FROM woori.albums a WHERE a."groupId"=${groupId}::uuid AND a."deletedAt" IS NULL ${after} ORDER BY a."createdAt" DESC,a.id DESC LIMIT ${limit + 1}`
        );
        const more = albums.length > limit;
        if (more) albums.pop();
        const stats = await albumStats(
          tx,
          groupId,
          userId,
          albums.map((album) => album.id)
        );
        return {
          albums: albums.map((album) => ({
            ...album,
            ...(stats.get(album.id) ?? EMPTY_STATS),
            canManage: membership.role === 'OWNER',
          })),
          nextCursor: more ? albums.at(-1)!.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  private async lockOwner(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string
  ) {
    const groups = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM woori.groups WHERE id=${groupId}::uuid AND status='ACTIVE' FOR UPDATE`;
    const owners = groups.length
      ? await tx.$queryRaw<
          { groupId: string }[]
        >`SELECT m."groupId" FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId"=${userId}::uuid AND m.role='OWNER' AND m.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,u`
      : [];
    if (!owners.length) this.notFound();
  }
  private notFound(): never {
    throw new NotFoundException({
      code: 'ALBUM_NOT_FOUND',
      message: '앨범을 찾을 수 없어요.',
    });
  }
  async rename(
    groupId: string,
    albumId: string,
    userId: string,
    title: string
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.lockOwner(tx, groupId, userId);
      const album = await tx.album.findFirst({
        where: { id: albumId, groupId, deletedAt: null },
      });
      if (!album) this.notFound();
      const updated = await tx.album.update({
        where: { id: albumId },
        data: { title },
        select: { id: true, groupId: true, title: true, createdAt: true },
      });
      const stats = await albumStats(tx, groupId, userId, [albumId]);
      return {
        ...updated,
        ...(stats.get(albumId) ?? EMPTY_STATS),
        canManage: true,
      };
    });
  }
  async remove(groupId: string, albumId: string, userId: string) {
    await this.prisma.client.$transaction(async (tx) => {
      await this.lockOwner(tx, groupId, userId);
      const album = await tx.album.findFirst({
        where: { id: albumId, groupId },
      });
      if (!album) this.notFound();
      if (album.deletedAt) return;
      await markPhotosDeleted(tx, groupId, { albumId });
      await tx.album.update({
        where: { id: albumId },
        data: { deletedAt: new Date() },
      });
    });
  }
}
