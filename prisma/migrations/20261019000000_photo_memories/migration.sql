-- Additive only: original files and existing dates are not rewritten.
ALTER TABLE woori.photos ADD COLUMN "manualCapturedDate" date,
 ADD COLUMN "captureMetadataCheckedAt" timestamptz(6);
CREATE TABLE woori.photo_memory_preferences (
 "userId" uuid NOT NULL,
 "photoId" uuid NOT NULL,
 "hiddenAt" timestamptz(6),
 CONSTRAINT "photo_memory_preferences_pkey" PRIMARY KEY ("userId", "photoId"),
 CONSTRAINT "photo_memory_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES woori.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "photo_memory_preferences_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES woori.photos(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE woori.photo_memory_preferences ENABLE ROW LEVEL SECURITY;
-- Match the fixed Asia/Seoul calendar used by the memory candidate query.
CREATE INDEX photos_memory_month_idx ON woori.photos (
 "groupId", (EXTRACT(MONTH FROM COALESCE("manualCapturedDate", (COALESCE("capturedAt", "createdAt") AT TIME ZONE INTERVAL '+09:00')::date))), id
) WHERE status='READY' AND "deletedAt" IS NULL;
