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
};
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
          (SELECT count(*)::int FROM woori.inquiries WHERE status IN ('RECEIVED','IN_PROGRESS')) AS "inquiriesOpen"`,
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    const m = rows[0];
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
      // Mail delivery metrics arrive with the W07 mail outbox.
      mail: null,
      generatedAt: new Date(),
    };
  }
}
