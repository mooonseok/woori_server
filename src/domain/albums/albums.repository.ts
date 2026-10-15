import { Injectable, NotFoundException } from '@nestjs/common';
import { markPhotosDeleted } from '../photos/photo-deletion';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { visiblePhotoWhere } from '../blocks/block-visibility';
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
        photoCount: 0,
        coverPhotoId: null,
        canManage: rows[0].role === 'OWNER',
      };
    });
  }
  hasMember(groupId: string, userId: string) {
    return this.prisma.client.membership.findFirst({
      where: {
        groupId,
        userId,
        status: 'ACTIVE',
        user: { status: 'ACTIVE' },
        group: { status: 'ACTIVE' },
      },
      select: { groupId: true, role: true },
    });
  }
  findActiveForMember(groupId: string, userId: string) {
    return this.prisma.client.album.findMany({
      where: {
        groupId,
        deletedAt: null,
        group: {
          status: 'ACTIVE',
          memberships: {
            some: { userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
          },
        },
      },
      select: {
        id: true,
        groupId: true,
        title: true,
        createdAt: true,
        // Count and cover share the viewer's photo visibility (personal blocks).
        _count: {
          select: { photos: { where: visiblePhotoWhere(userId) } },
        },
        photos: {
          where: visiblePhotoWhere(userId),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
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
        select: {
          id: true,
          groupId: true,
          title: true,
          createdAt: true,
          _count: {
            select: { photos: { where: visiblePhotoWhere(userId) } },
          },
          photos: {
            where: visiblePhotoWhere(userId),
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { id: true },
          },
        },
      });
      return {
        id: updated.id,
        groupId: updated.groupId,
        title: updated.title,
        createdAt: updated.createdAt,
        photoCount: updated._count.photos,
        coverPhotoId: updated.photos[0]?.id ?? null,
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
