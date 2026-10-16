-- Additive only (W07-4 operations readiness): two new tables, one enum and one
-- nullable column. No existing row changes.
-- mail_outbox: auth/recovery/email-change mails are queued in the same
-- transaction as their token and sent by the API (immediately) or the worker
-- (retries). The encrypted payload must be gone once a mail is DONE/FAILED.
-- worker_heartbeats: one row per worker process for the admin dashboard.
-- groups.deletionRequestedAt: group cleanup queue age (NULL for older rows).
-- CreateEnum
CREATE TYPE "woori"."MailKind" AS ENUM ('VERIFY_EMAIL', 'RECOVER_USERNAME', 'RESET_PASSWORD', 'CHANGE_EMAIL', 'EMAIL_CHANGED_NOTICE');

-- AlterTable
ALTER TABLE "woori"."groups" ADD COLUMN     "deletionRequestedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "woori"."mail_outbox" (
    "id" UUID NOT NULL,
    "kind" "woori"."MailKind" NOT NULL,
    "userId" UUID NOT NULL,
    "emailTokenId" UUID,
    "payload" TEXT,
    "status" "woori"."JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(6),
    "leaseToken" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "resultCode" VARCHAR(48),
    "sentAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."worker_heartbeats" (
    "instanceId" VARCHAR(64) NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "beatAt" TIMESTAMPTZ(6) NOT NULL,
    "lastPassOk" BOOLEAN NOT NULL,
    "videoReady" BOOLEAN NOT NULL,
    "busyJob" VARCHAR(48),
    "busySince" TIMESTAMPTZ(6),

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE INDEX "mail_outbox_status_nextAttemptAt_idx" ON "woori"."mail_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "mail_outbox_userId_idx" ON "woori"."mail_outbox"("userId");

-- CreateIndex
CREATE INDEX "mail_outbox_emailTokenId_idx" ON "woori"."mail_outbox"("emailTokenId");

-- CreateIndex
CREATE INDEX "mail_outbox_createdAt_idx" ON "woori"."mail_outbox"("createdAt");

-- AddForeignKey
ALTER TABLE "woori"."mail_outbox" ADD CONSTRAINT "mail_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."mail_outbox" ADD CONSTRAINT "mail_outbox_emailTokenId_fkey" FOREIGN KEY ("emailTokenId") REFERENCES "woori"."email_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."mail_outbox" ADD CONSTRAINT "mail_outbox_payload_wiped"
CHECK ("status" IN ('PENDING', 'RUNNING') OR "payload" IS NULL);
ALTER TABLE "woori"."mail_outbox" ADD CONSTRAINT "mail_outbox_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "woori"."worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_busy_pair"
CHECK (("busyJob" IS NULL) = ("busySince" IS NULL));

-- Internal schema only. The runtime role policy is provisioned by runtime-grants.sql.
ALTER TABLE "woori"."mail_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."worker_heartbeats" ENABLE ROW LEVEL SECURITY;
