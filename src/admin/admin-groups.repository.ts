import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { effectivePhotoDate } from '../domain/memories/memory-date';
import { writeAdminAudit } from './admin-audit';
import { adminCursorInvalid, adminNotFound } from './admin-errors';
import { likeLiteral } from './admin-users.repository';

type Tx = Prisma.TransactionClient;
type GroupRow = {
  id: string;
  name: string;
  status: string;
  ownerId: string;
  ownerDisplayName: string;
  memberCount: number;
  albumCount: number;
  photoCount: number;
  usedBytes: bigint;
  quotaBytes: bigint;
  createdAt: Date;
};
export function groupNotFound(): never {
  adminNotFound('ADMIN_GROUP_NOT_FOUND', '그룹을 찾을 수 없어요.');
}
// Counts are per-group correlated aggregates over indexed columns, bounded by
// the page size.
const groupColumns = Prisma.sql`g.id,g.name,g.status::text AS status,o.id AS "ownerId",o."displayName" AS "ownerDisplayName",
  (SELECT count(*)::int FROM woori.memberships m WHERE m."groupId"=g.id AND m.status='ACTIVE') AS "memberCount",
  (SELECT count(*)::int FROM woori.albums a WHERE a."groupId"=g.id AND a."deletedAt" IS NULL) AS "albumCount",
  (SELECT count(*)::int FROM woori.photos p WHERE p."groupId"=g.id AND p.status='READY' AND p."deletedAt" IS NULL) AS "photoCount",
  g."usedBytes",g."quotaBytes",g."createdAt"`;
const groupJoins = Prisma.sql`FROM woori.groups g JOIN woori.users o ON o.id=g."ownerId"`;
function summary(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    owner: { id: row.ownerId, displayName: row.ownerDisplayName },
    memberCount: row.memberCount,
    albumCount: row.albumCount,
    photoCount: row.photoCount,
    // Byte totals stay far below 2^53 (quota is 20 GiB by default).
    usedBytes: Number(row.usedBytes),
    quotaBytes: Number(row.quotaBytes),
    createdAt: row.createdAt,
  };
}
async function readGroup(tx: Tx, groupId: string) {
  const rows = await tx.$queryRaw<GroupRow[]>(
    Prisma.sql`SELECT ${groupColumns} ${groupJoins} WHERE g.id=${groupId}::uuid`
  );
  if (!rows.length) groupNotFound();
  return rows[0];
}
@Injectable()
export class AdminGroupsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async list(
    limit: number,
    filters: { query?: string; status?: string },
    cursor?: string
  ) {
    const client = this.prisma.client;
    if (
      cursor &&
      !(await client.group.findUnique({
        where: { id: cursor },
        select: { id: true },
      }))
    )
      adminCursorInvalid('ADMIN_GROUP_CURSOR_INVALID');
    const conditions = [
      filters.status
        ? Prisma.sql`AND g.status=${filters.status}::woori."GroupStatus"`
        : Prisma.empty,
      filters.query
        ? Prisma.sql`AND g.name ILIKE ${`%${likeLiteral(filters.query)}%`} ESCAPE '\\'`
        : Prisma.empty,
      cursor
        ? Prisma.sql`AND (g."createdAt",g.id)<(SELECT "createdAt",id FROM woori.groups WHERE id=${cursor}::uuid)`
        : Prisma.empty,
    ];
    const rows = await client.$queryRaw<GroupRow[]>(
      Prisma.sql`SELECT ${groupColumns} ${groupJoins} WHERE TRUE ${Prisma.join(conditions, ' ')} ORDER BY g."createdAt" DESC,g.id DESC LIMIT ${limit + 1}`
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      items: rows.map(summary),
      nextCursor: more ? rows.at(-1)!.id : null,
    };
  }
  // Members and albums are bounded to 200 each. Audited.
  view(adminId: string, groupId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const group = summary(await readGroup(tx, groupId));
      const members = await tx.$queryRaw<
        {
          userId: string;
          displayName: string;
          userStatus: string;
          role: string;
          status: string;
          joinedAt: Date | null;
        }[]
      >`SELECT u.id AS "userId",u."displayName",u.status::text AS "userStatus",m.role::text AS role,m.status::text AS status,m."joinedAt" FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid ORDER BY (m.role='OWNER') DESC,m."joinedAt" NULLS LAST,u.id LIMIT 200`;
      const albums = await tx.$queryRaw<
        {
          id: string;
          title: string;
          photoCount: number;
          createdAt: Date;
          deletedAt: Date | null;
        }[]
      >`SELECT a.id,a.title,(SELECT count(*)::int FROM woori.photos p WHERE p."albumId"=a.id AND p.status='READY' AND p."deletedAt" IS NULL) AS "photoCount",a."createdAt",a."deletedAt" FROM woori.albums a WHERE a."groupId"=${groupId}::uuid ORDER BY a."createdAt" DESC,a.id DESC LIMIT 200`;
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_GROUP_VIEWED',
        targetType: 'GROUP',
        targetId: groupId,
      });
      return {
        ...group,
        members: members.map((row) => ({
          user: {
            id: row.userId,
            displayName: row.displayName,
            status: row.userStatus,
          },
          role: row.role,
          status: row.status,
          joinedAt: row.joinedAt,
        })),
        albums,
      };
    });
  }
  // Photo metadata only (no EXIF/location, no bytes): image bytes are served
  // exclusively by the audited POST /v1/admin/photos/{photoId}/view. Each page
  // of a member album is still personal metadata, so every page is audited.
  albumPhotos(
    adminId: string,
    groupId: string,
    albumId: string,
    limit: number,
    cursor?: string
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      if (
        !(await tx.album.findFirst({
          where: { id: albumId, groupId },
          select: { id: true },
        }))
      )
        adminNotFound('ADMIN_ALBUM_NOT_FOUND', '앨범을 찾을 수 없어요.');
      if (
        cursor &&
        !(await tx.photo.findFirst({
          where: { id: cursor, albumId, groupId },
          select: { id: true },
        }))
      )
        adminCursorInvalid('ADMIN_PHOTO_CURSOR_INVALID');
      const after = cursor
        ? Prisma.sql`AND (p."createdAt",p.id)<(SELECT "createdAt",id FROM woori.photos WHERE id=${cursor}::uuid)`
        : Prisma.empty;
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          uploaderId: string;
          uploaderDisplayName: string;
          width: number | null;
          height: number | null;
          bytes: bigint;
          capturedAt: Date | null;
          manualCapturedDate: Date | null;
          createdAt: Date;
        }[]
      >(
        Prisma.sql`SELECT p.id,p.status::text AS status,u.id AS "uploaderId",u."displayName" AS "uploaderDisplayName",p.width,p.height,p.bytes,p."capturedAt",p."manualCapturedDate",p."createdAt" FROM woori.photos p JOIN woori.users u ON u.id=p."uploaderId" WHERE p."albumId"=${albumId}::uuid AND p."groupId"=${groupId}::uuid ${after} ORDER BY p."createdAt" DESC,p.id DESC LIMIT ${limit + 1}`
      );
      await writeAdminAudit(tx, {
        adminId,
        action: 'ADMIN_ALBUM_PHOTOS_VIEWED',
        targetType: 'ALBUM',
        targetId: albumId,
        metadata: { groupId },
      });
      const more = rows.length > limit;
      if (more) rows.pop();
      return {
        items: rows.map((row) => ({
          id: row.id,
          status: row.status,
          uploader: {
            id: row.uploaderId,
            displayName: row.uploaderDisplayName,
          },
          width: row.width,
          height: row.height,
          bytes: Number(row.bytes),
          effectiveDate: effectivePhotoDate(row).effectiveDate,
          createdAt: row.createdAt,
        })),
        nextCursor: more ? rows.at(-1)!.id : null,
      };
    });
  }
}
