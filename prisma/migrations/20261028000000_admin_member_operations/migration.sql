-- Additive only: indexes, no row or constraint changes. Admin member/group lists
-- and counts filter by status and order by creation time; the member detail
-- counts look up content by author/uploader/report target; the account deletion
-- ownership preflight and the dashboard's processing counts use the rest.
-- CreateIndex
CREATE INDEX "users_status_createdAt_id_idx" ON "woori"."users"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "groups_status_createdAt_id_idx" ON "woori"."groups"("status", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "groups_ownerId_status_idx" ON "woori"."groups"("ownerId", "status");

-- CreateIndex
CREATE INDEX "photos_uploaderId_status_idx" ON "woori"."photos"("uploaderId", "status");

-- CreateIndex
CREATE INDEX "photos_status_processingQueuedAt_idx" ON "woori"."photos"("status", "processingQueuedAt");

-- CreateIndex
CREATE INDEX "comments_authorId_idx" ON "woori"."comments"("authorId");

-- CreateIndex
CREATE INDEX "content_reports_targetUserId_status_idx" ON "woori"."content_reports"("targetUserId", "status");
