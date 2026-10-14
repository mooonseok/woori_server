import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/modules/prisma/prisma.service';

export interface CleanupClaim {
  id: string;
  photoId: string;
  objectKeys: string[];
  attempts: number;
  lockToken: string;
}
@Injectable()
export class MediaCleanupRepository {
  constructor(private readonly prisma: PrismaService) {}
  async claim(): Promise<CleanupClaim | null> {
    const token = randomUUID();
    const now = new Date();
    const until = new Date(now.getTime() + 15 * 60_000);
    const rows = await this.prisma.client.$queryRaw<CleanupClaim[]>`
      WITH candidate AS (
        SELECT j.id FROM woori.media_cleanup_jobs j
        JOIN woori.photos p ON p.id=j."photoId"
        WHERE j."completedAt" IS NULL AND j."availableAt" <= ${now}
          AND (j."lockedUntil" IS NULL OR j."lockedUntil" <= ${now})
          AND p."deletedAt" IS NOT NULL
        ORDER BY j."availableAt", j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      )
      UPDATE woori.media_cleanup_jobs j SET "lockToken"=${token}::uuid,
        "lockedUntil"=${until}, attempts=j.attempts+1, "updatedAt"=${now}
      FROM candidate c WHERE j.id=c.id
      RETURNING j.id,j."photoId",j."objectKeys",j.attempts,j."lockToken"`;
    return rows[0] ?? null;
  }
  async complete(job: CleanupClaim): Promise<boolean> {
    const now = new Date();
    const count = await this.prisma.client.$executeRaw`
      WITH finished AS (
        UPDATE woori.media_cleanup_jobs SET "completedAt"=${now}, "lockedUntil"=NULL,
          "lockToken"=NULL, "updatedAt"=${now}
        WHERE id=${job.id}::uuid AND "lockToken"=${job.lockToken}::uuid AND "lockedUntil">${now}
        RETURNING "photoId"
      )
      UPDATE woori.photos p SET status='DELETED' FROM finished f
      WHERE p.id=f."photoId" AND p."deletedAt" IS NOT NULL`;
    return count === 1;
  }
  async retry(job: CleanupClaim): Promise<void> {
    const now = new Date();
    const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7));
    const available = new Date(now.getTime() + delay * 1000);
    await this.prisma.client.$executeRaw`
      UPDATE woori.media_cleanup_jobs SET "availableAt"=${available}, "lockedUntil"=NULL,
        "lockToken"=NULL, "updatedAt"=${now}
      WHERE id=${job.id}::uuid AND "lockToken"=${job.lockToken}::uuid`;
  }
}
