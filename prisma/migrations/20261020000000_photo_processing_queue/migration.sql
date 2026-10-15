ALTER TABLE woori.photos
  ADD COLUMN "processingQueuedAt" timestamptz(6),
  ADD COLUMN "processingAvailableAt" timestamptz(6),
  ADD COLUMN "processingDeadlineAt" timestamptz(6),
  ADD COLUMN "processingAttempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "processingErrorCode" varchar(48);
CREATE INDEX photos_processing_queue_idx ON woori.photos ("processingAvailableAt", id)
  WHERE status = 'PROCESSING' AND "processingQueuedAt" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX photos_own_uploads_idx ON woori.photos ("albumId", "uploaderId", "createdAt" DESC, id DESC)
  WHERE "processingQueuedAt" IS NOT NULL AND "deletedAt" IS NULL;
