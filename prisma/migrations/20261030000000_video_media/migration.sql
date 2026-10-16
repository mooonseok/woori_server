-- Additive only (W07-3 video upload). A new enum, a NOT NULL column with a
-- constant default (PostgreSQL 11+ stores it as metadata: no table rewrite) and a
-- nullable column. Every existing row stays a PHOTO without a duration. A video
-- row reuses photos/photo_variants: its 'video' variant is the transcoded H.264
-- MP4 and its preview/thumbnail variants are poster images.
-- CreateEnum
CREATE TYPE "woori"."MediaKind" AS ENUM ('PHOTO', 'VIDEO');

-- AlterTable
ALTER TABLE "woori"."photos" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "mediaKind" "woori"."MediaKind" NOT NULL DEFAULT 'PHOTO';

-- Additional invariant not expressible in Prisma's schema DSL: only a video has
-- a duration, bounded by the 60 s (+0.5 s rounding) policy and transcode slack.
ALTER TABLE "woori"."photos" ADD CONSTRAINT "photos_video_duration"
CHECK ("durationMs" IS NULL OR ("mediaKind" = 'VIDEO' AND "durationMs" BETWEEN 1 AND 61000));

-- Widen (never narrow) the variant kinds: 'video' is the transcoded MP4. The
-- dimension/byte rules are unchanged; existing rows already satisfy the new
-- definition, so the replacement only validates them again.
ALTER TABLE "woori"."photo_variants" DROP CONSTRAINT "variant_dimensions_valid",
ADD CONSTRAINT "variant_dimensions_valid"
CHECK ("width" > 0 AND "height" > 0 AND "bytes" > 0 AND "kind" IN ('thumbnail', 'preview', 'original', 'video'));
