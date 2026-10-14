ALTER TABLE woori.photos
 ADD COLUMN "stagingKey" VARCHAR(512),
 ADD COLUMN "uploadMime" VARCHAR(80),
 ADD COLUMN "uploadBytes" BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN "reservedBytes" BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN "uploadExpiresAt" TIMESTAMPTZ(6),
 ADD COLUMN "processingToken" UUID,
 ADD COLUMN "processingUntil" TIMESTAMPTZ(6);
DROP INDEX woori."photos_albumId_status_createdAt_idx";
CREATE INDEX "photos_albumId_status_createdAt_id_idx" ON woori.photos("albumId",status,"createdAt",id);
CREATE INDEX "photos_groupId_status_uploadExpiresAt_idx" ON woori.photos("groupId",status,"uploadExpiresAt");
ALTER TABLE woori.photos ADD CONSTRAINT photos_upload_bytes_positive CHECK ("uploadBytes" >= 0 AND "reservedBytes" >= 0);
