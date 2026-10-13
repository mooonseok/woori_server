-- CreateTable
CREATE TABLE "woori"."email_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."rate_limit_buckets" (
    "id" VARCHAR(128) NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."invitations" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "tokenHash" VARCHAR(128) NOT NULL,
    "codeHash" VARCHAR(128) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "maxUses" INTEGER NOT NULL,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_tokens_tokenHash_key" ON "woori"."email_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "email_tokens_userId_purpose_expiresAt_idx" ON "woori"."email_tokens"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "rate_limit_buckets_windowStart_idx" ON "woori"."rate_limit_buckets"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "woori"."invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_codeHash_key" ON "woori"."invitations"("codeHash");

-- CreateIndex
CREATE INDEX "invitations_groupId_createdAt_idx" ON "woori"."invitations"("groupId", "createdAt");

-- AddForeignKey
ALTER TABLE "woori"."email_tokens" ADD CONSTRAINT "email_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."invitations" ADD CONSTRAINT "invitations_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "woori"."groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."invitations" ADD CONSTRAINT "invitations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "woori"."email_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."rate_limit_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."invitations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA "woori" FROM PUBLIC;
ALTER TABLE "woori"."invitations" ADD CONSTRAINT "invitation_capacity" CHECK ("maxUses" BETWEEN 1 AND 50 AND "useCount" BETWEEN 0 AND "maxUses");
ALTER TABLE "woori"."rate_limit_buckets" ADD CONSTRAINT "rate_attempts_nonnegative" CHECK ("attempts" >= 0);
