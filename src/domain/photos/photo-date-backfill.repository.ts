import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';

export type DateBackfillCandidate = {
  id: string;
  groupId: string;
  albumId: string;
  objectKey: string;
  bytes: bigint;
};
const scope = (after?: string): Prisma.PhotoWhereInput => ({
  status: 'READY',
  deletedAt: null,
  captureMetadataCheckedAt: null,
  group: { status: 'ACTIVE' },
  album: { deletedAt: null },
  variants: { some: { kind: 'original' } },
  ...(after ? { id: { gt: after } } : {}),
});
@Injectable()
export class PhotoDateBackfillRepository {
  constructor(private readonly prisma: PrismaService) {}
  count(after?: string) {
    return this.prisma.client.photo.count({ where: scope(after) });
  }
  async candidates(
    limit: number,
    after?: string
  ): Promise<DateBackfillCandidate[]> {
    const photos = await this.prisma.client.photo.findMany({
      where: scope(after),
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        groupId: true,
        albumId: true,
        variants: {
          where: { kind: 'original' },
          select: { objectKey: true, bytes: true },
        },
      },
    });
    return photos.map(({ variants, ...photo }) => ({
      ...photo,
      ...variants[0],
    }));
  }
  async eligible(candidate: DateBackfillCandidate): Promise<boolean> {
    return !!(await this.prisma.client.photo.findFirst({
      where: {
        ...scope(),
        id: candidate.id,
        groupId: candidate.groupId,
        albumId: candidate.albumId,
        variants: {
          some: {
            kind: 'original',
            objectKey: candidate.objectKey,
            bytes: candidate.bytes,
          },
        },
      },
      select: { id: true },
    }));
  }
  async save(
    candidate: DateBackfillCandidate,
    capturedAt: Date | null
  ): Promise<boolean> {
    return this.prisma.client.$transaction(async (tx) => {
      // Same lock order as photo interactions; never hold these locks during R2 I/O.
      const groups = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.groups WHERE id=${candidate.groupId}::uuid AND status='ACTIVE' FOR SHARE`;
      if (!groups.length) return false;
      const albums = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM woori.albums WHERE id=${candidate.albumId}::uuid AND "groupId"=${candidate.groupId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
      if (!albums.length) return false;
      const photos = await tx.$queryRaw<
        { id: string }[]
      >`SELECT p.id FROM woori.photos p WHERE p.id=${candidate.id}::uuid AND p."groupId"=${candidate.groupId}::uuid AND p."albumId"=${candidate.albumId}::uuid AND p.status='READY' AND p."deletedAt" IS NULL AND p."captureMetadataCheckedAt" IS NULL AND EXISTS (SELECT 1 FROM woori.photo_variants v WHERE v."photoId"=p.id AND v.kind='original' AND v."objectKey"=${candidate.objectKey} AND v.bytes=${candidate.bytes}) FOR UPDATE OF p`;
      if (!photos.length) return false;
      await tx.photo.update({
        where: { id: candidate.id },
        data: {
          capturedAt,
          captureDateSource: capturedAt ? 'EXIF' : null,
          captureMetadataCheckedAt: new Date(),
          // manualCapturedDate deliberately remains untouched, including concurrent edits.
        },
      });
      return true;
    });
  }
}
