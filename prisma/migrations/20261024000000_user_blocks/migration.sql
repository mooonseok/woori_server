-- Additive only: no existing row is changed. A block is personal and one-directional
-- ("나에게만 숨김"): it hides the blocked user's content and notifications from the
-- blocker only and never changes memberships, roles or what the blocked user sees.
-- CreateTable
CREATE TABLE "woori"."user_blocks" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateIndex
CREATE INDEX "user_blocks_blockedId_idx" ON "woori"."user_blocks"("blockedId");

-- AddForeignKey
ALTER TABLE "woori"."user_blocks" ADD CONSTRAINT "user_blocks_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "woori"."user_blocks" ADD CONSTRAINT "user_blocks_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."user_blocks" ADD CONSTRAINT "user_block_not_self"
CHECK ("blockerId" <> "blockedId");

-- Internal schema only. The runtime role policy is provisioned by runtime-grants.sql.
ALTER TABLE "woori"."user_blocks" ENABLE ROW LEVEL SECURITY;
