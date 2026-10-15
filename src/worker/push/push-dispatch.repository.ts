import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import {
  visible,
  type InboxRow,
} from '../../domain/notifications/notifications.repository';
import {
  evaluateNotification,
  type NotificationKind,
} from '../../domain/notifications/policies/notification-eligibility';
export type PushClaim = {
  id: string;
  notificationId: string;
  installationId: string;
  bindingVersion: number;
  leaseToken: string;
  attempts: number;
};
@Injectable()
export class PushDispatchRepository {
  constructor(private readonly prisma: PrismaService) {}
  async fanOutOne() {
    return this.prisma.client.$transaction(async (tx) => {
      // Fanout contains only database work; holding the row lock until commit is
      // sufficient. A crash rolls back both deliveries and outbox completion.
      const rows = await tx.$queryRaw<
        { id: string; aggregateId: string; createdAt: Date }[]
      >`SELECT id,"aggregateId","createdAt" FROM woori.outbox_events WHERE type='NOTIFICATION_PUSH' AND status='PENDING' AND "nextAttemptAt"<=now() ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`;
      const event = rows[0];
      if (!event) return false;
      const notification = await tx.notification.findUnique({
        where: { id: event.aggregateId },
      });
      if (notification) {
        const installations = await tx.pushInstallation.findMany({
          where: {
            userId: notification.recipientId,
            provider: 'WEB',
            enabled: true,
            revokedAt: null,
            boundAt: { lte: notification.createdAt },
            session: {
              revokedAt: null,
              expiresAt: { gt: new Date() },
              user: { status: 'ACTIVE' },
            },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          select: { id: true, bindingVersion: true },
        });
        await tx.notificationDelivery.createMany({
          data: installations.map((i) => ({
            notificationId: notification.id,
            installationId: i.id,
            bindingVersion: i.bindingVersion,
            deliveryKey: `${notification.id}:1:${i.id}:${i.bindingVersion}`,
          })),
          skipDuplicates: true,
        });
      }
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'DONE' },
      });
      return true;
    });
  }
  async claim(): Promise<PushClaim | null> {
    const token = randomUUID();
    const rows = await this.prisma.client.$queryRaw<
      PushClaim[]
    >`WITH candidate AS (
      SELECT id FROM woori.notification_deliveries WHERE (status='PENDING' AND "nextAttemptAt"<=now()) OR (status='RUNNING' AND "leaseUntil"<=now())
      ORDER BY "nextAttemptAt",id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE woori.notification_deliveries d SET status='RUNNING',"leaseToken"=${token}::uuid,"leaseUntil"=now()+interval '60 seconds' FROM candidate c WHERE d.id=c.id
      RETURNING d.id,d."notificationId",d."installationId",d."bindingVersion",d."leaseToken",d.attempts`;
    return rows[0] ?? null;
  }
  async eligibility(
    id: string,
    caller?: { userId: string; tokenHash: string }
  ) {
    const delivery = await this.prisma.client.notificationDelivery.findUnique({
      where: { id },
      include: {
        installation: { include: { session: true } },
        notification: true,
      },
    });
    if (!delivery || !['RUNNING', 'DONE'].includes(delivery.status))
      return null;
    if (delivery.status === 'DONE' && delivery.resultCode !== 'accepted')
      return null;
    const { installation: i, notification: n } = delivery;
    const now = new Date();
    if (
      i.provider !== 'WEB' ||
      !i.enabled ||
      i.revokedAt ||
      i.bindingVersion !== delivery.bindingVersion ||
      i.userId !== n.recipientId ||
      !i.session ||
      i.session.userId !== i.userId ||
      i.session.audience !== 'web' ||
      i.session.revokedAt ||
      i.session.expiresAt <= now ||
      (i.expiresAt && i.expiresAt <= now) ||
      n.createdAt.getTime() < Date.now() - 86_400_000
    )
      return null;
    if (
      caller &&
      (caller.userId !== i.userId || caller.tokenHash !== i.session.tokenHash)
    )
      return null;
    const rows = await this.prisma.client.$queryRaw<InboxRow[]>(
      Prisma.sql`WITH visible AS (${visible(i.userId)}) SELECT * FROM visible WHERE id=${n.id}::uuid`
    );
    if (!rows.length) return null;
    const row = rows[0];
    // visible() already hides blocked actors; the policy input is filled too so
    // the evaluation never relies on an empty placeholder.
    const blocks = await this.prisma.client.userBlock.findMany({
      where: { blockerId: i.userId, blockedId: row.actorId },
      select: { blockedId: true },
    });
    const p = await this.prisma.client.notificationPreference.findUnique({
      where: { userId: i.userId },
    });
    const group =
      await this.prisma.client.groupNotificationPreference.findUnique({
        where: { userId_groupId: { userId: i.userId, groupId: n.groupId } },
      });
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: p?.timeZone ?? 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const minute =
      Number(time.find((t) => t.type === 'hour')!.value) * 60 +
      Number(time.find((t) => t.type === 'minute')!.value);
    const decision = evaluateNotification(
      {
        id: n.id,
        groupId: n.groupId,
        targetId: n.targetId,
        kind: n.kind.toLowerCase() as NotificationKind,
        activities: [{ eventId: n.id, actorId: row.actorId, sequence: 1 }],
        readThroughSequence: n.readThroughSequence,
      },
      {
        recipientId: i.userId,
        activeAccount: true,
        activeInstallationSession: true,
        membershipGroupId: n.groupId,
        activeMembership: true,
        owner: false,
        intendedRecipient: true,
        targetAvailable: true,
        blockedActorIds: new Set(blocks.map((block) => block.blockedId)),
        pushPermission: true,
        enabled: p?.enabled ?? true,
        types: {
          photos: p?.photos ?? true,
          comments: p?.comments ?? true,
          reactions: p?.reactions ?? true,
          join: p?.join ?? true,
          memories: p?.memories ?? false,
        },
        groupMode: (group?.mode ?? 'DEFAULT').toLowerCase() as
          'default' | 'mine' | 'off',
        quiet: {
          enabled: p?.quietEnabled ?? false,
          startMinute: p?.quietStartMinute ?? 1320,
          endMinute: p?.quietEndMinute ?? 480,
          currentLocalMinute: minute,
        },
      }
    );
    return { delivery, decision, row, preview: p?.preview ?? false };
  }
  async beginSend(job: PushClaim) {
    const result = await this.prisma.client.$executeRaw`
      UPDATE woori.notification_deliveries d SET attempts=d.attempts+1
      FROM woori.push_installations i JOIN woori.sessions s ON s.id=i."sessionId"
      WHERE d.id=${job.id}::uuid AND d."leaseToken"=${job.leaseToken}::uuid AND d.status='RUNNING' AND d."leaseUntil">now() AND d.attempts<5
        AND i.id=d."installationId" AND i."bindingVersion"=d."bindingVersion" AND i.enabled AND i."revokedAt" IS NULL
        AND (i."expiresAt" IS NULL OR i."expiresAt">now()) AND s."revokedAt" IS NULL AND s."expiresAt">now() AND s."userId"=i."userId"`;
    return result === 1;
  }

  async finish(
    job: PushClaim,
    resultCode: string,
    options: { retryAfterMs?: number; failed?: boolean; revoke?: boolean } = {}
  ) {
    await this.prisma.client.$transaction(async (tx) => {
      const result = await tx.notificationDelivery.updateMany({
        where: {
          id: job.id,
          leaseToken: job.leaseToken,
          status: 'RUNNING',
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: options.retryAfterMs
            ? 'PENDING'
            : options.failed
              ? 'FAILED'
              : 'DONE',
          resultCode,
          leaseToken: null,
          leaseUntil: null,
          ...(options.retryAfterMs
            ? { nextAttemptAt: new Date(Date.now() + options.retryAfterMs) }
            : {}),
        },
      });
      if (result.count && options.revoke)
        await tx.pushInstallation.updateMany({
          where: { id: job.installationId, bindingVersion: job.bindingVersion },
          data: {
            enabled: false,
            revokedAt: new Date(),
            bindingVersion: { increment: 1 },
          },
        });
    });
  }
}
