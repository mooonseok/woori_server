import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';

export const groupSummarySelect = (userId: string) =>
  ({
    id: true,
    name: true,
    memberships: {
      where: { userId, status: 'ACTIVE' as const },
      select: { role: true },
    },
    _count: {
      select: {
        memberships: {
          where: {
            status: 'ACTIVE' as const,
            user: { status: 'ACTIVE' as const },
          },
        },
      },
    },
  }) satisfies Prisma.GroupSelect;
export function groupSummary(group: {
  id: string;
  name: string;
  memberships: { role: 'OWNER' | 'MEMBER' }[];
  _count: { memberships: number };
}) {
  return {
    id: group.id,
    name: group.name,
    members: group._count.memberships,
    role: group.memberships[0].role,
  };
}
@Injectable()
export class GroupsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async list(userId: string) {
    const groups = await this.prisma.client.group.findMany({
      where: {
        status: 'ACTIVE',
        memberships: {
          some: { userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
        },
      },
      select: groupSummarySelect(userId),
      orderBy: { createdAt: 'desc' },
    });
    return groups.map(groupSummary);
  }
  async findForMember(groupId: string, userId: string) {
    const group = await this.prisma.client.group.findFirst({
      where: {
        id: groupId,
        status: 'ACTIVE',
        memberships: {
          some: { userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
        },
      },
      select: groupSummarySelect(userId),
    });
    return group ? groupSummary(group) : null;
  }
  async create(name: string, ownerId: string) {
    const group = await this.prisma.client.group.create({
      data: {
        name,
        ownerId,
        memberships: {
          create: {
            userId: ownerId,
            role: 'OWNER',
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
        },
      },
      select: groupSummarySelect(ownerId),
    });
    return groupSummary(group);
  }
}
