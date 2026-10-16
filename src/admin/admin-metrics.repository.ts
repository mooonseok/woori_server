import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
type MetricsRow = {
  usersActive: number;
  usersSuspended: number;
  usersDeleted: number;
  groupsActive: number;
  groupsDeleting: number;
  photosQueued: number;
  photosProcessing: number;
  photosFailed24h: number;
  cleanupPending: number;
  cleanupRetrying: number;
  pushPending: number;
  pushFailed24h: number;
  outboxPending: number;
  storageUsed: bigint;
  storageQuota: bigint;
  reportsOpen: number;
  inquiriesOpen: number;
  mailPending: number;
  mailFailed24h: number;
  mailSent24h: number;
};
// Oldest due job per queue. Each due-time column is compared with the clock
// that writes it (app clock below; the heartbeat age uses the DB clock).
type QueueRow = {
  queue: string;
  due: number;
  oldest: Date | null;
};
type WorkerRow = {
  instanceId: string;
  startedAt: Date;
  beatAgeSeconds: number;
  lastPassOk: boolean;
  videoReady: boolean;
  busyJob: string | null;
  busySeconds: number | null;
};
export const WORKER_STALE_SECONDS = 120;
// Read-only dashboard: one snapshot of bounded count/sum aggregates.
@Injectable()
export class AdminMetricsRepository {
  constructor(private readonly prisma: PrismaService) {}
  async snapshot() {
    const rows = await this.prisma.client.$transaction(
      (tx) =>
        tx.$queryRaw<MetricsRow[]>`SELECT
          (SELECT count(*)::int FROM woori.users WHERE status='ACTIVE') AS "usersActive",
          (SELECT count(*)::int FROM woori.users WHERE status='SUSPENDED') AS "usersSuspended",
          (SELECT count(*)::int FROM woori.users WHERE status='DELETED') AS "usersDeleted",
          (SELECT count(*)::int FROM woori.groups WHERE status='ACTIVE') AS "groupsActive",
          (SELECT count(*)::int FROM woori.groups WHERE status='DELETING') AS "groupsDeleting",
          (SELECT count(*)::int FROM woori.photos WHERE status='PROCESSING' AND "deletedAt" IS NULL AND "processingQueuedAt" IS NOT NULL AND ("processingUntil" IS NULL OR "processingUntil"<=now())) AS "photosQueued",
          (SELECT count(*)::int FROM woori.photos WHERE status='PROCESSING' AND "deletedAt" IS NULL AND "processingUntil">now()) AS "photosProcessing",
          (SELECT count(*)::int FROM woori.photos WHERE status='FAILED' AND "processingQueuedAt">now()-interval '24 hours') AS "photosFailed24h",
          (SELECT count(*)::int FROM woori.media_cleanup_jobs WHERE "completedAt" IS NULL AND attempts=0) AS "cleanupPending",
          (SELECT count(*)::int FROM woori.media_cleanup_jobs WHERE "completedAt" IS NULL AND attempts>0) AS "cleanupRetrying",
          (SELECT count(*)::int FROM woori.notification_deliveries WHERE status IN ('PENDING','RUNNING')) AS "pushPending",
          (SELECT count(*)::int FROM woori.notification_deliveries WHERE status='FAILED' AND "nextAttemptAt">now()-interval '24 hours') AS "pushFailed24h",
          (SELECT count(*)::int FROM woori.outbox_events WHERE status='PENDING') AS "outboxPending",
          (SELECT COALESCE(sum("usedBytes"),0)::bigint FROM woori.groups WHERE status='ACTIVE') AS "storageUsed",
          (SELECT COALESCE(sum("quotaBytes"),0)::bigint FROM woori.groups WHERE status='ACTIVE') AS "storageQuota",
          (SELECT count(*)::int FROM woori.content_reports WHERE status IN ('RECEIVED','REVIEWING')) AS "reportsOpen",
          (SELECT count(*)::int FROM woori.inquiries WHERE status IN ('RECEIVED','IN_PROGRESS')) AS "inquiriesOpen",
          (SELECT count(*)::int FROM woori.mail_outbox WHERE status IN ('PENDING','RUNNING')) AS "mailPending",
          (SELECT count(*)::int FROM woori.mail_outbox WHERE status='FAILED' AND "createdAt">now()-interval '24 hours') AS "mailFailed24h",
          (SELECT count(*)::int FROM woori.mail_outbox WHERE status='DONE' AND "sentAt">now()-interval '24 hours') AS "mailSent24h"`,
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    const m = rows[0];
    const now = new Date();
    const queues = await this.prisma.client.$queryRaw<QueueRow[]>`
      SELECT 'photoProcessing' AS queue,count(*)::int AS due,min("processingAvailableAt") AS oldest FROM woori.photos
        WHERE status='PROCESSING' AND "deletedAt" IS NULL AND "processingQueuedAt" IS NOT NULL
          AND "processingAvailableAt"<=${now} AND ("processingUntil" IS NULL OR "processingUntil"<=${now})
      UNION ALL SELECT 'mediaCleanup',count(*)::int,min("availableAt") FROM woori.media_cleanup_jobs
        WHERE "completedAt" IS NULL AND "availableAt"<=${now}
      UNION ALL SELECT 'pushOutbox',count(*)::int,min("nextAttemptAt") FROM woori.outbox_events
        WHERE status='PENDING' AND "nextAttemptAt"<=${now}
      UNION ALL SELECT 'pushDeliveries',count(*)::int,min("nextAttemptAt") FROM woori.notification_deliveries
        WHERE status='PENDING' AND "nextAttemptAt"<=${now}
      UNION ALL SELECT 'mailOutbox',count(*)::int,min("nextAttemptAt") FROM woori.mail_outbox
        WHERE status='PENDING' AND "nextAttemptAt"<=${now}
      UNION ALL SELECT 'groupCleanup',count(*)::int,min("deletionRequestedAt") FROM woori.groups
        WHERE status='DELETING'`;
    const workers = await this.prisma.client.$queryRaw<WorkerRow[]>`
      SELECT "instanceId","startedAt",EXTRACT(EPOCH FROM now()-"beatAt")::int AS "beatAgeSeconds","lastPassOk","videoReady",
        "busyJob",EXTRACT(EPOCH FROM now()-"busySince")::int AS "busySeconds"
      FROM woori.worker_heartbeats WHERE "beatAt">now()-interval '24 hours'
      ORDER BY "beatAt" DESC LIMIT 20`;
    const queue = (name: string) => {
      const row = queues.find((entry) => entry.queue === name);
      return {
        due: row?.due ?? 0,
        oldestDueSeconds: row?.oldest
          ? Math.max(
              0,
              Math.floor((now.getTime() - row.oldest.getTime()) / 1000)
            )
          : null,
      };
    };
    return {
      users: {
        active: m.usersActive,
        suspended: m.usersSuspended,
        deleted: m.usersDeleted,
      },
      groups: { active: m.groupsActive, deleting: m.groupsDeleting },
      photoProcessing: {
        queued: m.photosQueued,
        processing: m.photosProcessing,
        failed24h: m.photosFailed24h,
      },
      mediaCleanup: { pending: m.cleanupPending, retrying: m.cleanupRetrying },
      push: { pendingDeliveries: m.pushPending, failed24h: m.pushFailed24h },
      outbox: { pending: m.outboxPending },
      storage: {
        usedBytes: Number(m.storageUsed),
        quotaBytes: Number(m.storageQuota),
      },
      reports: { open: m.reportsOpen },
      inquiries: { open: m.inquiriesOpen },
      mail: {
        pending: m.mailPending,
        failed24h: m.mailFailed24h,
        sent24h: m.mailSent24h,
      },
      queues: {
        photoProcessing: queue('photoProcessing'),
        mediaCleanup: queue('mediaCleanup'),
        pushOutbox: queue('pushOutbox'),
        pushDeliveries: queue('pushDeliveries'),
        mailOutbox: queue('mailOutbox'),
        groupCleanup: queue('groupCleanup'),
      },
      // Healthy: a worker beat within WORKER_STALE_SECONDS after a clean pass.
      workers: {
        healthy: workers.some(
          (worker) =>
            worker.beatAgeSeconds <= WORKER_STALE_SECONDS && worker.lastPassOk
        ),
        staleAfterSeconds: WORKER_STALE_SECONDS,
        instances: workers.map((worker) => ({
          instanceId: worker.instanceId,
          startedAt: worker.startedAt,
          beatAgeSeconds: worker.beatAgeSeconds,
          lastPassOk: worker.lastPassOk,
          videoReady: worker.videoReady,
          // A long transcode shows here while the beat stays fresh.
          busyJob: worker.busyJob,
          busySeconds: worker.busySeconds,
        })),
      },
      generatedAt: new Date(),
    };
  }
}
