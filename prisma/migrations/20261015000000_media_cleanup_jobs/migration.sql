CREATE TABLE woori.media_cleanup_jobs (
  id UUID NOT NULL,
  "photoId" UUID NOT NULL,
  "objectKeys" TEXT[] NOT NULL,
  "availableAt" TIMESTAMPTZ(6) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lockedUntil" TIMESTAMPTZ(6),
  "lockToken" UUID,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT media_cleanup_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT media_cleanup_jobs_photo_fkey FOREIGN KEY ("photoId") REFERENCES woori.photos(id) ON DELETE RESTRICT,
  CONSTRAINT media_cleanup_jobs_lease CHECK (("lockedUntil" IS NULL) = ("lockToken" IS NULL))
);
CREATE UNIQUE INDEX media_cleanup_jobs_photo_key ON woori.media_cleanup_jobs("photoId");
CREATE INDEX media_cleanup_jobs_due_idx ON woori.media_cleanup_jobs("completedAt", "availableAt", "lockedUntil");
ALTER TABLE woori.media_cleanup_jobs ENABLE ROW LEVEL SECURITY;
