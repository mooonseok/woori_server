import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, GroupStatus } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  groupSummary,
  groupSummarySelect,
  rosterUser,
} from './groups.repository';

@Injectable()
export class GroupManagementRepository {
  constructor(private readonly prisma: PrismaService) {}

  private missing(): never {
    throw new NotFoundException({
      code: 'GROUP_NOT_FOUND',
      message: '그룹을 찾을 수 없어요.',
    });
  }
  private conflict(code: string, message: string): never {
    throw new ConflictException({ code, message });
  }
  private async lock(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
    targetId?: string,
    deleting = false
  ) {
    // Shared order with upload publication, invitations and the deletion worker.
    const groups = await tx.$queryRaw<
      { id: string; name: string; ownerId: string; status: GroupStatus }[]
    >`
      SELECT id,name,"ownerId",status FROM woori.groups WHERE id=${groupId}::uuid FOR UPDATE`;
    const group = groups[0];
    if (!group || (!deleting && group.status !== 'ACTIVE')) this.missing();
    const ids = [...new Set([userId, ...(targetId ? [targetId] : [])])].sort();
    await tx.$queryRaw`SELECT "userId" FROM woori.memberships WHERE "groupId"=${groupId}::uuid AND "userId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY "userId" FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM woori.users WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`;
    const actor = await tx.membership.findFirst({
      where: { groupId, userId, status: 'ACTIVE', user: { status: 'ACTIVE' } },
      select: { role: true },
    });
    if (!actor) this.missing();
    return { group, actor };
  }
  private owner(
    group: { ownerId: string },
    actor: { role: string },
    userId: string
  ) {
    if (group.ownerId !== userId || actor.role !== 'OWNER')
      throw new ForbiddenException({
        code: 'GROUP_OWNER_REQUIRED',
        message: '그룹장만 변경할 수 있어요.',
      });
  }
  private async summary(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string
  ) {
    return {
      group: groupSummary(
        await tx.group.findUniqueOrThrow({
          where: { id: groupId },
          select: groupSummarySelect(userId),
        })
      ),
    };
  }
  members(groupId: string, userId: string, limit: number, after?: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.lock(tx, groupId, userId);
      const rows = await tx.membership.findMany({
        where: {
          groupId,
          status: 'ACTIVE',
          // Suspended members stay listed (no suspension field is exposed).
          user: rosterUser,
          ...(after ? { userId: { gt: after } } : {}),
        },
        orderBy: { userId: 'asc' },
        take: limit + 1,
        select: {
          userId: true,
          role: true,
          joinedAt: true,
          user: {
            select: {
              displayName: true,
              // Only this viewer's own block; roster membership is unchanged.
              blockedBy: {
                where: { blockerId: userId },
                select: { blockerId: true },
              },
            },
          },
        },
      });
      const more = rows.length > limit;
      if (more) rows.pop();
      return {
        members: rows.map(({ user, ...row }) => ({
          ...row,
          displayName: user.displayName,
          blockedByMe: user.blockedBy.length > 0,
        })),
        nextCursor: more ? rows.at(-1)!.userId : null,
      };
    });
  }
  rename(groupId: string, userId: string, name: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const { group, actor } = await this.lock(tx, groupId, userId);
      this.owner(group, actor, userId);
      await tx.group.update({ where: { id: groupId }, data: { name } });
      return this.summary(tx, groupId, userId);
    });
  }
  async leave(groupId: string, userId: string) {
    await this.prisma.client.$transaction(async (tx) => {
      const { group, actor } = await this.lock(tx, groupId, userId);
      if (actor.role === 'OWNER' || group.ownerId === userId)
        this.conflict(
          'GROUP_OWNER_CANNOT_LEAVE',
          '그룹장을 다른 멤버에게 넘기거나 그룹을 삭제한 뒤 나갈 수 있어요.'
        );
      await tx.membership.update({
        where: { groupId_userId: { groupId, userId } },
        data: { status: 'LEFT' },
      });
    });
  }
  async remove(groupId: string, userId: string, targetId: string) {
    await this.prisma.client.$transaction(async (tx) => {
      const { group, actor } = await this.lock(tx, groupId, userId, targetId);
      this.owner(group, actor, userId);
      // Any non-owner membership may be removed, including a suspended
      // member's (only the acting owner must be ACTIVE).
      const target = await tx.membership.findUnique({
        where: { groupId_userId: { groupId, userId: targetId } },
      });
      if (
        !target ||
        targetId === userId ||
        target.role === 'OWNER' ||
        !['ACTIVE', 'REMOVED'].includes(target.status)
      )
        this.conflict(
          'GROUP_MEMBER_UNAVAILABLE',
          '내보낼 멤버를 다시 확인해 주세요.'
        );
      await tx.membership.update({
        where: { groupId_userId: { groupId, userId: targetId } },
        data: { status: 'REMOVED' },
      });
    });
  }
  transfer(groupId: string, userId: string, targetId: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const { group, actor } = await this.lock(tx, groupId, userId, targetId);
      this.owner(group, actor, userId);
      // Ownership goes to ACTIVE accounts only (a suspended target: 409).
      const target = await tx.membership.findFirst({
        where: {
          groupId,
          userId: targetId,
          role: 'MEMBER',
          status: 'ACTIVE',
          user: { status: 'ACTIVE' },
        },
      });
      if (!target || targetId === userId)
        this.conflict(
          'GROUP_MEMBER_UNAVAILABLE',
          '그룹장을 넘길 멤버를 다시 확인해 주세요.'
        );
      await tx.membership.update({
        where: { groupId_userId: { groupId, userId } },
        data: { role: 'MEMBER' },
      });
      await tx.membership.update({
        where: { groupId_userId: { groupId, userId: targetId } },
        data: { role: 'OWNER' },
      });
      await tx.group.update({
        where: { id: groupId },
        data: { ownerId: targetId },
      });
      await tx.invitation.updateMany({
        where: { groupId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return this.summary(tx, groupId, userId);
    });
  }
  async delete(groupId: string, userId: string, name: string) {
    await this.prisma.client.$transaction(async (tx) => {
      const { group, actor } = await this.lock(
        tx,
        groupId,
        userId,
        undefined,
        true
      );
      this.owner(group, actor, userId);
      if (group.name !== name)
        this.conflict(
          'GROUP_NAME_MISMATCH',
          '현재 그룹 이름을 정확히 입력해 주세요.'
        );
      if (group.status !== 'ACTIVE') return;
      // DELETING is the durable work marker. Every content read already excludes it.
      // The worker resumes bounded photo/album cleanup from this state after crashes.
      await tx.group.update({
        where: { id: groupId },
        data: { status: 'DELETING', deletionRequestedAt: new Date() },
      });
      await tx.invitation.updateMany({
        where: { groupId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { accepted: true };
  }
}
