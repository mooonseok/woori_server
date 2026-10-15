-- Additive only: no existing row is changed. Reports are handled only by the
-- service operator (admin API later); members never change report status, and
-- no notification or automatic hiding is triggered by a report.
-- CreateEnum
CREATE TYPE "woori"."ReportTargetType" AS ENUM ('PHOTO', 'COMMENT', 'USER');

-- CreateEnum
CREATE TYPE "woori"."ReportReason" AS ENUM ('INAPPROPRIATE', 'HARASSMENT', 'PRIVACY', 'SPAM', 'OTHER');

-- CreateEnum
CREATE TYPE "woori"."ReportStatus" AS ENUM ('RECEIVED', 'REVIEWING', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "woori"."content_reports" (
    "id" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "targetType" "woori"."ReportTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "reason" "woori"."ReportReason" NOT NULL,
    "detail" VARCHAR(500),
    "status" "woori"."ReportStatus" NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_reports_reporterId_createdAt_id_idx" ON "woori"."content_reports"("reporterId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "content_reports_status_createdAt_idx" ON "woori"."content_reports"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_reports_reporterId_targetType_targetId_key" ON "woori"."content_reports"("reporterId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_reports_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_reports_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_report_not_self"
CHECK ("reporterId" <> "targetUserId");
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_report_user_target"
CHECK ("targetType" <> 'USER' OR "targetId" = "targetUserId");
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_report_detail_present"
CHECK ("detail" IS NULL OR char_length("detail") > 0);

-- Internal schema only. The runtime role policy is provisioned by runtime-grants.sql.
ALTER TABLE "woori"."content_reports" ENABLE ROW LEVEL SECURITY;
