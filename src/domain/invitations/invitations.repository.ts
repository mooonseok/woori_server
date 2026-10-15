import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { groupSummary, groupSummarySelect } from '../groups/groups.repository';
import {
  assertInvitationAvailable,
  assertJoinableMembership,
  invalidInvitation,
} from './invitation-policy';

const metadataSelect = {
  id: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
  maxUses: true,
  useCount: true,
} satisfies Prisma.InvitationSelect;
@Injectable()
export class InvitationsRepository {
  constructor(private readonly prisma: PrismaService) {}
  private async serial<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.prisma.client.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError))
          throw error;
        const adapter = error.meta?.driverAdapterError as
          { cause?: { originalCode?: string } } | undefined;
        const sqlState = error.meta?.code ?? adapter?.cause?.originalCode;
        const retryable =
          error.code === 'P2034' ||
          (error.code === 'P2010' &&
            (sqlState === '40001' || sqlState === '40P01'));
        if (!retryable) throw error;
        if (attempt === 3)
          throw new ConflictException({
            code: 'INVITATION_RETRY',
            message: '다른 요청이 처리 중이에요. 다시 시도해 주세요.',
          });
      }
    }
    throw new Error('Unreachable transaction state');
  }
  private async requireOwner(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string
  ) {
    await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${groupId}::uuid FOR UPDATE`;
    const owner = await tx.group.findFirst({
      where: {
        id: groupId,
        ownerId: userId,
        status: 'ACTIVE',
        owner: { status: 'ACTIVE' },
        memberships: { some: { userId, role: 'OWNER', status: 'ACTIVE' } },
      },
      select: { id: true },
    });
    if (!owner)
      throw new NotFoundException({
        code: 'GROUP_NOT_FOUND',
        message: '그룹을 찾을 수 없어요.',
      });
  }
  create(
    groupId: string,
    userId: string,
    input: {
      tokenHash: string;
      codeHash: string;
      expiresAt: Date;
      maxUses: number;
    }
  ) {
    return this.serial(async (tx) => {
      await this.requireOwner(tx, groupId, userId);
      return tx.invitation.create({
        data: { ...input, groupId, createdById: userId },
        select: metadataSelect,
      });
    });
  }
  list(groupId: string, userId: string) {
    return this.serial(async (tx) => {
      await this.requireOwner(tx, groupId, userId);
      return tx.invitation.findMany({
        where: { groupId },
        select: metadataSelect,
        orderBy: { createdAt: 'desc' },
      });
    });
  }
  revoke(groupId: string, id: string, userId: string) {
    return this.serial(async (tx) => {
      await this.requireOwner(tx, groupId, userId);
      const found = await tx.invitation.findFirst({
        where: { id, groupId },
        select: { id: true },
      });
      if (!found)
        throw new NotFoundException({
          code: 'INVITATION_NOT_FOUND',
          message: '초대를 찾을 수 없어요.',
        });
      await tx.invitation.updateMany({
        where: { id, groupId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
  private async findAvailable(
    tx: Prisma.TransactionClient,
    lookup: { codeHash?: string; tokenHash?: string }
  ) {
    const invitation = await tx.invitation.findFirst({
      where: lookup,
      include: {
        group: {
          select: { id: true, name: true, status: true, ownerId: true },
        },
        creator: { select: { status: true } },
      },
    });
    if (
      !invitation ||
      invitation.group.status !== 'ACTIVE' ||
      invitation.creator.status !== 'ACTIVE' ||
      invitation.group.ownerId !== invitation.createdById
    )
      invalidInvitation();
    const creatorMembership = await tx.membership.findUnique({
      where: {
        groupId_userId: {
          groupId: invitation.groupId,
          userId: invitation.createdById,
        },
      },
      select: { status: true, role: true },
    });
    if (
      creatorMembership?.status !== 'ACTIVE' ||
      creatorMembership.role !== 'OWNER'
    )
      invalidInvitation();
    assertInvitationAvailable(invitation, new Date(), false);
    return invitation;
  }
  preview(lookup: { codeHash?: string; tokenHash?: string }) {
    return this.serial(async (tx) => {
      const invitation = await this.findAvailable(tx, lookup);
      assertInvitationAvailable(invitation);
      return {
        groupName: invitation.group.name,
        expiresAt: invitation.expiresAt,
      };
    });
  }
  join(lookup: { codeHash?: string; tokenHash?: string }, userId: string) {
    return this.serial(async (tx) => {
      const initial = await tx.invitation.findFirst({
        where: lookup,
        select: { groupId: true },
      });
      if (!initial) invalidInvitation();
      await tx.$queryRaw`SELECT id FROM woori.groups WHERE id=${initial.groupId}::uuid FOR UPDATE`;
      const invitation = await this.findAvailable(tx, lookup);
      const key = { groupId: invitation.groupId, userId };
      const member = await tx.membership.findUnique({
        where: { groupId_userId: key },
        select: { status: true },
      });
      assertJoinableMembership(member?.status);
      const alreadyMember = member?.status === 'ACTIVE';
      if (!alreadyMember) {
        assertInvitationAvailable(invitation);
        await tx.invitation.update({
          where: { id: invitation.id },
          data: { useCount: { increment: 1 } },
        });
        await tx.membership.upsert({
          where: { groupId_userId: key },
          create: {
            ...key,
            status: 'ACTIVE',
            role: 'MEMBER',
            joinedAt: new Date(),
          },
          update: { status: 'ACTIVE', role: 'MEMBER', joinedAt: new Date() },
        });
      }
      const group = await tx.group.findUniqueOrThrow({
        where: { id: invitation.groupId },
        select: groupSummarySelect(userId),
      });
      return { group: groupSummary(group), alreadyMember };
    });
  }
}
