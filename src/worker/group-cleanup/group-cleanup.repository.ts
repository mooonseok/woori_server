import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { markPhotosDeleted } from '../../domain/photos/photo-deletion';

export interface GroupCleanupProgress {
  groupId: string;
  photos: number;
  albums: number;
  completed: boolean;
}

@Injectable()
export class GroupCleanupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async progress(
    excludeIds: string[] = []
  ): Promise<GroupCleanupProgress | null> {
    return this.prisma.client.$transaction(async (tx) => {
      // DELETING is the durable work marker. Only actionable groups are claimed:
      // an earlier group waiting for signed uploads/R2 retry must not block others.
      const excluded = excludeIds.length
        ? Prisma.sql`AND g.id NOT IN (${Prisma.join(excludeIds.map((id) => Prisma.sql`${id}::uuid`))})`
        : Prisma.empty;
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT g.id FROM woori.groups g
        WHERE g.status='DELETING' ${excluded} AND (
          EXISTS (SELECT 1 FROM woori.photos p WHERE p."groupId"=g.id AND p."deletedAt" IS NULL)
          OR EXISTS (SELECT 1 FROM woori.albums a WHERE a."groupId"=g.id AND a."deletedAt" IS NULL)
          OR (g."usedBytes"=0
            AND NOT EXISTS (SELECT 1 FROM woori.photos p WHERE p."groupId"=g.id
              AND (p."deletedAt" IS NULL OR p.status<>'DELETED'))
            AND NOT EXISTS (SELECT 1 FROM woori.media_cleanup_jobs j
              JOIN woori.photos p ON p.id=j."photoId"
              WHERE p."groupId"=g.id AND j."completedAt" IS NULL))
        )
        ORDER BY g."createdAt", g.id FOR UPDATE OF g SKIP LOCKED LIMIT 1
      `);
      const group = rows[0];
      if (!group) return null;

      const photos = await markPhotosDeleted(tx, group.id, {}, 100);
      const albums = await tx.album.findMany({
        where: { groupId: group.id, deletedAt: null },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      if (albums.length)
        await tx.album.updateMany({
          where: {
            groupId: group.id,
            id: { in: albums.map((album) => album.id) },
            deletedAt: null,
          },
          data: { deletedAt: new Date() },
        });

      // R2 work is performed by MediaCleanupService outside this transaction.
      // Its verified completion is required before the group can be finalized.
      const completed = await tx.$executeRaw`
        UPDATE woori.groups g SET status='DELETED'
        WHERE g.id=${group.id}::uuid AND g.status='DELETING' AND g."usedBytes"=0
          AND NOT EXISTS (SELECT 1 FROM woori.albums a WHERE a."groupId"=g.id AND a."deletedAt" IS NULL)
          AND NOT EXISTS (SELECT 1 FROM woori.photos p WHERE p."groupId"=g.id
            AND (p."deletedAt" IS NULL OR p.status<>'DELETED'))
          AND NOT EXISTS (SELECT 1 FROM woori.media_cleanup_jobs j
            JOIN woori.photos p ON p.id=j."photoId"
            WHERE p."groupId"=g.id AND j."completedAt" IS NULL)
      `;
      return {
        groupId: group.id,
        photos,
        albums: albums.length,
        completed: completed === 1,
      };
    });
  }
}
