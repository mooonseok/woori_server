-- Additive only: no existing row is changed. Members read published notices and
-- their own inquiries; notice authoring and inquiry answers wait for the admin API.
-- CreateEnum
CREATE TYPE "woori"."NoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "woori"."InquiryCategory" AS ENUM ('ACCOUNT', 'GROUP', 'PHOTO', 'NOTIFICATION', 'BUG', 'OTHER');

-- CreateEnum
CREATE TYPE "woori"."InquiryStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'ANSWERED', 'CLOSED');

-- CreateTable
CREATE TABLE "woori"."notices" (
    "id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" VARCHAR(10000) NOT NULL,
    "status" "woori"."NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "woori"."inquiries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "woori"."InquiryCategory" NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "body" VARCHAR(2000) NOT NULL,
    "status" "woori"."InquiryStatus" NOT NULL DEFAULT 'RECEIVED',
    "answer" VARCHAR(4000),
    "answeredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notices_status_publishedAt_id_idx" ON "woori"."notices"("status", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "inquiries_userId_createdAt_id_idx" ON "woori"."inquiries"("userId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "woori"."inquiries" ADD CONSTRAINT "inquiries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "woori"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma's schema DSL.
ALTER TABLE "woori"."notices" ADD CONSTRAINT "notice_published_has_date"
CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);
ALTER TABLE "woori"."notices" ADD CONSTRAINT "notice_text_present"
CHECK (char_length("title") > 0 AND char_length("body") > 0);
ALTER TABLE "woori"."inquiries" ADD CONSTRAINT "inquiry_text_present"
CHECK (char_length("title") > 0 AND char_length("body") > 0);

-- Internal schema only. The runtime role policy is provisioned by runtime-grants.sql.
ALTER TABLE "woori"."notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "woori"."inquiries" ENABLE ROW LEVEL SECURITY;
