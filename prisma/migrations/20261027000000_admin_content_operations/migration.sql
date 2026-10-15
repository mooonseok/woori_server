-- Additive only: no existing row is changed. Operator processing of notices,
-- inquiries and reports: an operator-only report outcome column (members never
-- see it) and indexes for the admin lists and same-target report counts.
-- AlterTable
ALTER TABLE "woori"."content_reports" ADD COLUMN     "resolution" VARCHAR(32);

-- CreateIndex
CREATE INDEX "notices_updatedAt_id_idx" ON "woori"."notices"("updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "inquiries_createdAt_id_idx" ON "woori"."inquiries"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "inquiries_status_createdAt_id_idx" ON "woori"."inquiries"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "content_reports_targetType_targetId_status_idx" ON "woori"."content_reports"("targetType", "targetId", "status");

-- Additional invariants not expressible in Prisma's schema DSL. Existing rows have
-- no resolution, so these hold for current data.
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_report_resolution_value"
CHECK ("resolution" IS NULL OR "resolution" IN ('CONTENT_DELETED', 'USER_SUSPENDED', 'NO_ACTION'));
ALTER TABLE "woori"."content_reports" ADD CONSTRAINT "content_report_resolution_closed"
CHECK ("resolution" IS NULL OR "status" IN ('RESOLVED', 'DISMISSED'));
