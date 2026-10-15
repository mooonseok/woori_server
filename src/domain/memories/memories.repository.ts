import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  notFound,
  PhotosRepository,
  photoSummary,
} from '../photos/photos.repository';
import {
  effectivePhotoDate,
  memoryCalendar,
  MEMORY_TIME_ZONE,
} from './memory-date';
import type { MemoriesQueryDto } from './dto/memories.dto';
import { notBlockedBySql } from '../blocks/block-visibility';

type PhotoRow = Omit<
  Prisma.PhotoGetPayload<{ select: typeof photoSummary }>,
  'uploader'
> & {
  albumTitle: string;
  effectiveDate: Date;
  uploaderName: string;
};
const dateExpression = Prisma.sql`COALESCE(p."manualCapturedDate", (COALESCE(p."capturedAt",p."createdAt") AT TIME ZONE INTERVAL '+09:00')::date)`;
@Injectable()
export class MemoriesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly photos: PhotosRepository
  ) {}
  private async withGroup<T>(
    groupId: string,
    userId: string,
    operation: (tx: Prisma.TransactionClient, owner: boolean) => Promise<T>
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const groups = await tx.$queryRaw<
        { ownerId: string }[]
      >`SELECT "ownerId" FROM woori.groups WHERE id=${groupId}::uuid AND status='ACTIVE' FOR SHARE`;
      if (!groups.length) notFound();
      const members = await tx.$queryRaw<
        { role: string }[]
      >`SELECT m.role FROM woori.memberships m JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,u`;
      if (!members.length) notFound();
      return operation(
        tx,
        groups[0].ownerId === userId && members[0].role === 'OWNER'
      );
    });
  }
  list(groupId: string, userId: string, q: MemoriesQueryDto, now = new Date()) {
    const calendar = memoryCalendar(now);
    return this.withGroup(groupId, userId, async (tx, owner) => {
      const matchesDay = Prisma.sql`(EXTRACT(DAY FROM ${dateExpression})=${calendar.day} OR (${calendar.includeLeapDay} AND EXTRACT(DAY FROM ${dateExpression})=29))`;
      const hidden = Prisma.sql`EXISTS(SELECT 1 FROM woori.photo_memory_preferences h WHERE h."photoId"=p.id AND h."userId"=${userId}::uuid AND h."hiddenAt" IS NOT NULL)`;
      const category =
        q.kind === 'hidden'
          ? hidden
          : Prisma.sql`NOT ${hidden} AND EXTRACT(YEAR FROM ${dateExpression})<${calendar.year} AND EXTRACT(MONTH FROM ${dateExpression})=${calendar.month} AND ${q.kind === 'today' ? matchesDay : Prisma.sql`NOT ${matchesDay}`}`;
      // Every kind (today/month/hidden) and its cursor exclude uploaders this
      // viewer blocked.
      const visible = Prisma.sql`FROM woori.photos p JOIN woori.albums a ON a.id=p."albumId" AND a."groupId"=p."groupId" AND a."deletedAt" IS NULL JOIN woori.users up ON up.id=p."uploaderId" WHERE p."groupId"=${groupId}::uuid AND p.status='READY' AND p."deletedAt" IS NULL AND ${notBlockedBySql(userId, Prisma.sql`p."uploaderId"`)} AND ${category}`;
      let older = Prisma.empty;
      if (q.cursor) {
        const anchor = await tx.$queryRaw<{ date: Date }[]>(
          Prisma.sql`SELECT ${dateExpression} AS date ${visible} AND p.id=${q.cursor}::uuid`
        );
        if (!anchor.length) notFound();
        older = Prisma.sql`AND (${dateExpression},p.id)<(${anchor[0].date}::date,${q.cursor}::uuid)`;
      }
      const rows = await tx.$queryRaw<PhotoRow[]>(
        Prisma.sql`SELECT p.id,p."groupId",p."albumId",p."uploaderId",p.width,p.height,p."capturedAt",p."manualCapturedDate",p."captureDateSource",p."createdAt",p.status,a.title AS "albumTitle",up."displayName" AS "uploaderName",${dateExpression} AS "effectiveDate" ${visible} ${older} ORDER BY ${dateExpression} DESC,p.id DESC LIMIT ${q.limit + 1}`
      );
      const more = rows.length > q.limit;
      if (more) rows.pop();
      return {
        asOf: calendar.asOf,
        timeZone: MEMORY_TIME_ZONE,
        kind: q.kind,
        items: rows.map((row) => ({
          photo: this.photos.summary(
            {
              ...row,
              uploader: { id: row.uploaderId, displayName: row.uploaderName },
            },
            owner || row.uploaderId === userId
          ),
          albumTitle: row.albumTitle,
          ...effectivePhotoDate(row),
          yearsAgo: Math.max(
            0,
            calendar.year -
              Number(effectivePhotoDate(row).effectiveDate.slice(0, 4))
          ),
        })),
        nextCursor: more ? rows.at(-1)!.id : null,
      };
    });
  }
  // Capture-date edits and hide/restore use the same viewer visibility as the
  // list: a photo whose uploader this viewer blocked is not found.
  private async lockPhoto(
    tx: Prisma.TransactionClient,
    groupId: string,
    photoId: string,
    userId: string,
    albumId?: string
  ) {
    const initial = await tx.photo.findFirst({
      where: { id: photoId, groupId, ...(albumId ? { albumId } : {}) },
      select: { albumId: true },
    });
    if (!initial) notFound();
    const albums = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM woori.albums WHERE id=${initial.albumId}::uuid AND "groupId"=${groupId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
    if (!albums.length) notFound();
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT p.id FROM woori.photos p WHERE p.id=${photoId}::uuid AND p."groupId"=${groupId}::uuid AND p."albumId"=${initial.albumId}::uuid AND p.status='READY' AND p."deletedAt" IS NULL AND ${notBlockedBySql(userId, Prisma.sql`p."uploaderId"`)} FOR UPDATE OF p`
    );
    if (!rows.length) notFound();
    return tx.photo.findUniqueOrThrow({
      where: { id: photoId },
      select: photoSummary,
    });
  }
  captureDate(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    date: Date | null
  ) {
    return this.withGroup(groupId, userId, async (tx, owner) => {
      const photo = await this.lockPhoto(tx, groupId, photoId, userId, albumId);
      if (!owner && photo.uploaderId !== userId) notFound();
      const updated = await tx.photo.update({
        where: { id: photoId },
        data: { manualCapturedDate: date },
        select: photoSummary,
      });
      return { photo: this.photos.summary(updated, true) };
    });
  }
  async setHidden(
    groupId: string,
    photoId: string,
    userId: string,
    hidden: boolean
  ) {
    await this.withGroup(groupId, userId, async (tx) => {
      await this.lockPhoto(tx, groupId, photoId, userId);
      if (hidden)
        await tx.photoMemoryPreference.upsert({
          where: { userId_photoId: { userId, photoId } },
          create: { userId, photoId, hiddenAt: new Date() },
          update: { hiddenAt: new Date() },
        });
      else
        await tx.photoMemoryPreference.updateMany({
          where: { userId, photoId },
          data: { hiddenAt: null },
        });
    });
  }
}
