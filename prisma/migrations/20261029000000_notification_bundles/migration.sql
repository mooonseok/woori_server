-- Additive only: two nullable columns, one constant-default column and one index.
-- No existing row is rewritten (PostgreSQL 11+ stores a constant default as
-- metadata). Existing notifications keep their meaning: bundleKey NULL is a single
-- event, lastSequence 1 matches their one activity (sequence 1), and an activity
-- with photoId NULL refers to its notification's target as before.
-- Upload (same uploader + album, 10 minutes) and reaction (same photo, 30 minutes)
-- bundles reuse notifications/notification_activities: bundleUntil is fixed when a
-- bundle opens, lastSequence is the monotonic activity counter used for unread and
-- push keys, and the index serves the per-recipient open-bundle lookup.
-- AlterTable
ALTER TABLE "woori"."notifications" ADD COLUMN     "bundleKey" VARCHAR(256),
ADD COLUMN     "bundleUntil" TIMESTAMPTZ(6),
ADD COLUMN     "lastSequence" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "woori"."notification_activities" ADD COLUMN     "photoId" UUID;

-- CreateIndex
CREATE INDEX "notifications_recipientId_bundleKey_bundleUntil_idx" ON "woori"."notifications"("recipientId", "bundleKey", "bundleUntil");
