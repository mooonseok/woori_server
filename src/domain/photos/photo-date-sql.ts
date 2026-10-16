import { Prisma } from '@prisma/client';

// SQL form of effectivePhotoDate() for a photos row aliased `p`: manual capture
// date -> EXIF capture time -> upload time, as a Korea (fixed UTC+09:00) calendar
// date. Shared by memories and album date ranges so they can never disagree.
export const effectivePhotoDateSql = Prisma.sql`COALESCE(p."manualCapturedDate", (COALESCE(p."capturedAt",p."createdAt") AT TIME ZONE INTERVAL '+09:00')::date)`;
