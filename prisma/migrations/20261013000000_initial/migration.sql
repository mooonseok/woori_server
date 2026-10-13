-- DRAFT: generated offline from schema; never applied to any database.
-- Review role grants and backups before an explicit deployment migration.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "woori";

-- CreateEnum
CREATE TYPE "woori"."UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "woori"."GroupStatus" AS ENUM ('ACTIVE', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "woori"."MembershipStatus" AS ENUM ('ACTIVE', 'PENDING', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "woori"."MemberRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "woori"."PhotoStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "woori"."CommentKind" AS ENUM ('GENERAL', 'PIN');

-- CreateEnum
CREATE TYPE "woori"."NotificationKind" AS ENUM ('PHOTOS', 'COMMENT', 'PIN', 'REACTION', 'JOIN_REQUEST', 'JOIN_RESULT', 'MEMORY');

-- CreateEnum
CREATE TYPE "woori"."GroupNotificationMode" AS ENUM ('DEFAULT', 'MINE', 'OFF');

-- CreateEnum
CREATE TYPE "woori"."JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "woori"."users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "displayName" VARCHAR(80) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" VARCHAR(512) NOT NULL,
    "status" "woori"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "verifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."groups" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "ownerId" UUID NOT NULL,
    "status" "woori"."GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "quotaBytes" BIGINT NOT NULL DEFAULT 21474836480,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."memberships" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "woori"."MemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "woori"."MembershipStatus" NOT NULL DEFAULT 'PENDING',
    "joinedAt" TIMESTAMPTZ(6),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "woori"."albums" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "creatorId" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."photos" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "albumId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "status" "woori"."PhotoStatus" NOT NULL DEFAULT 'PENDING',
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "capturedAt" TIMESTAMPTZ(6),
    "captureDateSource" VARCHAR(24),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."photo_variants" (
    "id" UUID NOT NULL,
    "photoId" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "objectKey" VARCHAR(512) NOT NULL,
    "mime" VARCHAR(80) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,

    CONSTRAINT "photo_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."comments" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "photoId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "kind" "woori"."CommentKind" NOT NULL DEFAULT 'GENERAL',
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "parentId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."reactions" (
    "photoId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emoji" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reactions_pkey" PRIMARY KEY ("photoId","userId")
);

-- CreateTable
CREATE TABLE "woori"."notification_preferences" (
    "userId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "photos" BOOLEAN NOT NULL DEFAULT true,
    "comments" BOOLEAN NOT NULL DEFAULT true,
    "reactions" BOOLEAN NOT NULL DEFAULT true,
    "join" BOOLEAN NOT NULL DEFAULT true,
    "memories" BOOLEAN NOT NULL DEFAULT false,
    "preview" BOOLEAN NOT NULL DEFAULT false,
    "quietEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quietStartMinute" INTEGER NOT NULL DEFAULT 1320,
    "quietEndMinute" INTEGER NOT NULL DEFAULT 480,
    "timeZone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Seoul',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "woori"."group_notification_preferences" (
    "userId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "mode" "woori"."GroupNotificationMode" NOT NULL DEFAULT 'DEFAULT',

    CONSTRAINT "group_notification_preferences_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateTable
CREATE TABLE "woori"."notifications" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "kind" "woori"."NotificationKind" NOT NULL,
    "targetId" UUID NOT NULL,
    "dedupeKey" VARCHAR(256) NOT NULL,
    "readThroughSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."notification_activities" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventKey" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."push_installations" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "endpointCiphertext" TEXT NOT NULL,
    "endpointHash" VARCHAR(128) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMPTZ(6),

    CONSTRAINT "push_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."notification_deliveries" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "deliveryKey" VARCHAR(256) NOT NULL,
    "status" "woori"."JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(6),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."outbox_events" (
    "id" UUID NOT NULL,
    "eventKey" VARCHAR(256) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "woori"."JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "woori"."users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "woori"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "woori"."sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_expiresAt_idx" ON "woori"."sessions"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "memberships_userId_status_idx" ON "woori"."memberships"("userId", "status");

-- CreateIndex
CREATE INDEX "albums_groupId_deletedAt_createdAt_idx" ON "woori"."albums"("groupId", "deletedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "albums_id_groupId_key" ON "woori"."albums"("id", "groupId");

-- CreateIndex
CREATE INDEX "photos_albumId_status_createdAt_idx" ON "woori"."photos"("albumId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "photos_id_groupId_key" ON "woori"."photos"("id", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "photo_variants_objectKey_key" ON "woori"."photo_variants"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "photo_variants_photoId_kind_key" ON "woori"."photo_variants"("photoId", "kind");

-- CreateIndex
CREATE INDEX "comments_photoId_createdAt_idx" ON "woori"."comments"("photoId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "comments_id_photoId_key" ON "woori"."comments"("id", "photoId");

-- CreateIndex
CREATE INDEX "notifications_recipientId_createdAt_idx" ON "woori"."notifications"("recipientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipientId_dedupeKey_key" ON "woori"."notifications"("recipientId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "notification_activities_notificationId_eventKey_key" ON "woori"."notification_activities"("notificationId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "notification_activities_notificationId_sequence_key" ON "woori"."notification_activities"("notificationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "push_installations_endpointHash_key" ON "woori"."push_installations"("endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_deliveryKey_key" ON "woori"."notification_deliveries"("deliveryKey");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_nextAttemptAt_idx" ON "woori"."notification_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_eventKey_key" ON "woori"."outbox_events"("eventKey");

-- CreateIndex
CREATE INDEX "outbox_events_status_nextAttemptAt_idx" ON "woori"."outbox_events"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "woori"."sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."groups" ADD CONSTRAINT "groups_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."memberships" ADD CONSTRAINT "memberships_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."albums" ADD CONSTRAINT "albums_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."albums" ADD CONSTRAINT "albums_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."photos" ADD CONSTRAINT "photos_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."photos" ADD CONSTRAINT "photos_albumId_groupId_fkey" FOREIGN KEY ("albumId", "groupId") REFERENCES "woori"."albums"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."photos" ADD CONSTRAINT "photos_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."photo_variants" ADD CONSTRAINT "photo_variants_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "woori"."photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."comments" ADD CONSTRAINT "comments_photoId_groupId_fkey" FOREIGN KEY ("photoId", "groupId") REFERENCES "woori"."photos"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."comments" ADD CONSTRAINT "comments_parentId_photoId_fkey" FOREIGN KEY ("parentId", "photoId") REFERENCES "woori"."comments"("id", "photoId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "woori"."reactions" ADD CONSTRAINT "reactions_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "woori"."photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."reactions" ADD CONSTRAINT "reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."group_notification_preferences" ADD CONSTRAINT "group_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."group_notification_preferences" ADD CONSTRAINT "group_notification_preferences_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notifications" ADD CONSTRAINT "notifications_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notifications" ADD CONSTRAINT "notifications_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notification_activities" ADD CONSTRAINT "notification_activities_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "woori"."notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."push_installations" ADD CONSTRAINT "push_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "woori"."notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."notification_deliveries" ADD CONSTRAINT "notification_deliveries_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "woori"."push_installations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."users" ADD CONSTRAINT "users_normalized_identity"
CHECK ("username" = lower("username") AND length(trim("username")) > 0 AND "email" = lower("email"));
ALTER TABLE "woori"."groups" ADD CONSTRAINT "group_storage_nonnegative"
CHECK ("quotaBytes" >= 0 AND "usedBytes" >= 0 AND "usedBytes" <= "quotaBytes");
ALTER TABLE "woori"."photos" ADD CONSTRAINT "photo_dimensions_valid"
CHECK ("bytes" >= 0 AND ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
AND ("status" <> 'READY' OR ("width" IS NOT NULL AND "height" IS NOT NULL AND "bytes" > 0)));
ALTER TABLE "woori"."photo_variants" ADD CONSTRAINT "variant_dimensions_valid"
CHECK ("width" > 0 AND "height" > 0 AND "bytes" > 0 AND "kind" IN ('thumbnail', 'preview', 'original'));
ALTER TABLE "woori"."comments" ADD CONSTRAINT "comment_coordinates_by_kind"
CHECK (("kind" = 'GENERAL' AND "x" IS NULL AND "y" IS NULL) OR
("kind" = 'PIN' AND "x" IS NOT NULL AND "y" IS NOT NULL AND "x" >= 0 AND "x" <= 1 AND "y" >= 0 AND "y" <= 1));
ALTER TABLE "woori"."comments" ADD CONSTRAINT "comment_not_own_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id");
ALTER TABLE "woori"."notification_preferences" ADD CONSTRAINT "notification_preferences_valid"
CHECK ("quietStartMinute" BETWEEN 0 AND 1439 AND "quietEndMinute" BETWEEN 0 AND 1439 AND "version" >= 0);
ALTER TABLE "woori"."notifications" ADD CONSTRAINT "notification_read_sequence_valid" CHECK ("readThroughSequence" >= 0);
ALTER TABLE "woori"."notification_activities" ADD CONSTRAINT "notification_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "woori"."notification_deliveries" ADD CONSTRAINT "delivery_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "woori"."outbox_events" ADD CONSTRAINT "outbox_attempts_nonnegative" CHECK ("attempts" >= 0);

-- Internal schema only. No browser role policies/grants are created.
-- API/worker role grants and policies must be reviewed before live DB use.
-- Table owners can bypass RLS; API authorization remains mandatory.
REVOKE ALL ON SCHEMA "woori" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "woori" FROM PUBLIC;
ALTER TABLE "woori"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."albums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."photo_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."reactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."group_notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."notification_activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."push_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."notification_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."outbox_events" ENABLE ROW LEVEL SECURITY;
