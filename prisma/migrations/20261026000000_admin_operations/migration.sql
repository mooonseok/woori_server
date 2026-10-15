-- Additive only: no existing row is changed. Service operator (admin) accounts,
-- sessions and an append-only audit log, fully separate from member accounts and
-- sessions. Admin accounts are created only by the owner-connection CLI.
-- CreateEnum
CREATE TYPE "woori"."AdminStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "woori"."admin_accounts" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "passwordHash" VARCHAR(512) NOT NULL,
    "status" "woori"."AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "totpSecretCiphertext" TEXT,
    "totpEnabledAt" TIMESTAMPTZ(6),
    "totpLastUsedStep" BIGINT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."admin_sessions" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(6),
    "reauthAt" TIMESTAMPTZ(6),
    "mfaFailedCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."admin_audit_logs" (
    "id" UUID NOT NULL,
    "adminId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "targetType" VARCHAR(32),
    "targetId" UUID,
    "reason" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_accounts_username_key" ON "woori"."admin_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_tokenHash_key" ON "woori"."admin_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_sessions_adminId_idx" ON "woori"."admin_sessions"("adminId");

-- CreateIndex
CREATE INDEX "admin_audit_logs_createdAt_id_idx" ON "woori"."admin_audit_logs"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_targetType_targetId_createdAt_idx" ON "woori"."admin_audit_logs"("targetType", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_adminId_createdAt_idx" ON "woori"."admin_audit_logs"("adminId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_createdAt_id_idx" ON "woori"."admin_audit_logs"("action", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "woori"."admin_sessions" ADD CONSTRAINT "admin_sessions_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "woori"."admin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "woori"."admin_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."admin_accounts" ADD CONSTRAINT "admin_account_username_format"
CHECK ("username" ~ '^[a-z0-9_]{3,32}$');
ALTER TABLE "woori"."admin_accounts" ADD CONSTRAINT "admin_account_display_name_present"
CHECK (char_length("displayName") > 0);
ALTER TABLE "woori"."admin_accounts" ADD CONSTRAINT "admin_account_totp_secret_when_enabled"
CHECK ("totpEnabledAt" IS NULL OR "totpSecretCiphertext" IS NOT NULL);
ALTER TABLE "woori"."admin_accounts" ADD CONSTRAINT "admin_account_failed_login_count"
CHECK ("failedLoginCount" >= 0);
ALTER TABLE "woori"."admin_sessions" ADD CONSTRAINT "admin_session_idle_within_absolute"
CHECK ("idleExpiresAt" <= "expiresAt");
ALTER TABLE "woori"."admin_sessions" ADD CONSTRAINT "admin_session_mfa_failed_count"
CHECK ("mfaFailedCount" >= 0);
ALTER TABLE "woori"."admin_audit_logs" ADD CONSTRAINT "admin_audit_action_format"
CHECK ("action" ~ '^[A-Z][A-Z_]{2,63}$');
ALTER TABLE "woori"."admin_audit_logs" ADD CONSTRAINT "admin_audit_metadata_object"
CHECK (jsonb_typeof("metadata") = 'object');
ALTER TABLE "woori"."admin_audit_logs" ADD CONSTRAINT "admin_audit_reason_present"
CHECK ("reason" IS NULL OR char_length("reason") > 0);
ALTER TABLE "woori"."admin_audit_logs" ADD CONSTRAINT "admin_audit_target_pair"
CHECK ("targetId" IS NULL OR "targetType" IS NOT NULL);

-- Internal schema only. The runtime role policy is provisioned by runtime-grants.sql.
ALTER TABLE "woori"."admin_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."admin_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."admin_audit_logs" ENABLE ROW LEVEL SECURITY;
