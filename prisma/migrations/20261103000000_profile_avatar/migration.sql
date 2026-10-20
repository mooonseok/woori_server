-- Profile photo (avatar). avatarKey is the folder of the current square
-- renditions (avatars/{userId}/{token}); avatarVersion changes on every replace
-- or removal so clients can cache by user id + version.
ALTER TABLE woori.users ADD COLUMN "avatarKey" VARCHAR(160);
ALTER TABLE woori.users ADD COLUMN "avatarVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE woori.users ADD CONSTRAINT users_avatar_version CHECK ("avatarVersion" >= 0);
ALTER TABLE woori.users ADD CONSTRAINT users_avatar_key CHECK (
  "avatarKey" IS NULL OR "avatarKey" ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}$'
);

-- A signed avatar upload: the staging object (staging/{id}) belongs to one user,
-- declares its type and size, and expires. Completion is recorded once.
CREATE TABLE woori.avatar_uploads (
  id UUID NOT NULL,
  "userId" UUID NOT NULL,
  "contentType" VARCHAR(32) NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT avatar_uploads_pkey PRIMARY KEY (id),
  CONSTRAINT avatar_uploads_user_fkey FOREIGN KEY ("userId") REFERENCES woori.users(id) ON DELETE RESTRICT
);
CREATE INDEX avatar_uploads_user_idx ON woori.avatar_uploads("userId", "createdAt");
ALTER TABLE woori.avatar_uploads ENABLE ROW LEVEL SECURITY;

-- Durable deletion of a user's storage objects that belong to no photo
-- (replaced or removed avatars and abandoned avatar staging uploads).
CREATE TABLE woori.storage_cleanup_jobs (
  id UUID NOT NULL,
  "userId" UUID NOT NULL,
  "objectKeys" TEXT[] NOT NULL,
  "availableAt" TIMESTAMPTZ(6) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "lockedUntil" TIMESTAMPTZ(6),
  "lockToken" UUID,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT storage_cleanup_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT storage_cleanup_jobs_user_fkey FOREIGN KEY ("userId") REFERENCES woori.users(id) ON DELETE RESTRICT,
  CONSTRAINT storage_cleanup_jobs_lease CHECK (("lockedUntil" IS NULL) = ("lockToken" IS NULL)),
  CONSTRAINT storage_cleanup_jobs_keys CHECK (cardinality("objectKeys") BETWEEN 1 AND 10)
);
CREATE INDEX storage_cleanup_jobs_due_idx ON woori.storage_cleanup_jobs("completedAt", "availableAt", "lockedUntil");
ALTER TABLE woori.storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;
