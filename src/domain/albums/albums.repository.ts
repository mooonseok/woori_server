import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../common/modules/prisma/prisma.service";
@Injectable()
export class AlbumsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async create(groupId: string, userId: string, title: string) {
    return this.prisma.client.$transaction(async (tx) => {
      // A locked membership keeps removal from racing this write.
      const rows = await tx.$queryRaw<
        { groupId: string }[]
      >`SELECT m."groupId" FROM woori.memberships m JOIN woori.groups g ON g.id=m."groupId" JOIN woori.users u ON u.id=m."userId" WHERE m."groupId"=${groupId}::uuid AND m."userId"=${userId}::uuid AND m.status='ACTIVE' AND g.status='ACTIVE' AND u.status='ACTIVE' FOR SHARE OF m,g,u`;
      if (!rows.length)
        throw new NotFoundException({
          code: "GROUP_NOT_FOUND",
          message: "그룹을 찾을 수 없어요.",
        });
      const album = await tx.album.create({
        data: { groupId, creatorId: userId, title },
        select: { id: true, groupId: true, title: true, createdAt: true },
      });
      return { ...album, photoCount: 0, coverPhotoId: null };
    });
  }
  hasMember(groupId: string, userId: string) {
    return this.prisma.client.membership.findFirst({
      where: {
        groupId,
        userId,
        status: "ACTIVE",
        user: { status: "ACTIVE" },
        group: { status: "ACTIVE" },
      },
      select: { groupId: true },
    });
  }
  findActiveForMember(groupId: string, userId: string) {
    return this.prisma.client.album.findMany({
      where: {
        groupId,
        deletedAt: null,
        group: {
          status: "ACTIVE",
          memberships: {
            some: { userId, status: "ACTIVE", user: { status: "ACTIVE" } },
          },
        },
      },
      select: {
        id: true,
        groupId: true,
        title: true,
        createdAt: true,
        _count: {
          select: { photos: { where: { status: "READY", deletedAt: null } } },
        },
        photos: {
          where: { status: "READY", deletedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
}
