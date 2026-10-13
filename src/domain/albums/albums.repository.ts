import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
@Injectable()
export class AlbumsRepository {
  constructor(private readonly prisma: PrismaService) {}
  hasMember(groupId: string, userId: string) {
    return this.prisma.client.membership.findFirst({where:{groupId,userId,status:'ACTIVE',user:{status:'ACTIVE'},group:{status:'ACTIVE'}},select:{groupId:true}});
  }
  findActiveForMember(groupId: string, userId: string) {
    return this.prisma.client.album.findMany({
      where: { groupId, deletedAt: null, group: { status: 'ACTIVE', memberships: { some: { userId, status: 'ACTIVE', user: { status: 'ACTIVE' } } } } },
      select: { id: true, groupId: true, title: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 50,
    });
  }
}
