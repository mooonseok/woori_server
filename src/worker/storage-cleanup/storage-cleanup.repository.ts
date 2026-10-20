import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { AVATAR_UPLOAD_RETENTION_MS } from '../../domain/avatars/avatars.repository';

export interface StorageCleanupClaim {
  id: string;
  userId: string;
  objectKeys: string[];
  attempts: number;
  lockToken: string;
}
// Leased like media_cleanup_jobs: one job per claim, exponential retry.
@Injectable()
export class StorageCleanupRepository {
  constructor(private readonly prisma: PrismaService) {}
  async claim(): Promise<StorageCleanupClaim | null> {
    const token = randomUUID();
    const now = new Date();
    const until = new Date(now.getTime() + 15 * 60_000);
    const rows = await this.prisma.client.$queryRaw<StorageCleanupClaim[]>`
      WITH candidate AS (
        SELECT j.id FROM woori.storage_cleanup_jobs j
        WHERE j."completedAt" IS NULL AND j."availableAt" <= ${now}
          AND (j."lockedUntil" IS NULL OR j."lockedUntil" <= ${now})
        ORDER BY j."availableAt", j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      )
      UPDATE woori.storage_cleanup_jobs j SET "lockToken"=${token}::uuid,
        "lockedUntil"=${until}, attempts=j.attempts+1, "updatedAt"=${now}
      FROM candidate c WHERE j.id=c.id
      RETURNING j.id,j."userId",j."objectKeys",j.attempts,j."lockToken"`;
    return rows[0] ?? null;
  }
  async complete(job: StorageCleanupClaim): Promise<boolean> {
    const now = new Date();
    const count = await this.prisma.client.$executeRaw`
      UPDATE woori.storage_cleanup_jobs SET "completedAt"=${now}, "lockedUntil"=NULL,
        "lockToken"=NULL, "updatedAt"=${now}
      WHERE id=${job.id}::uuid AND "lockToken"=${job.lockToken}::uuid AND "lockedUntil">${now}`;
    return count === 1;
  }
  async retry(job: StorageCleanupClaim): Promise<void> {
    const now = new Date();
    const delay = Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7));
    const available = new Date(now.getTime() + delay * 1000);
    await this.prisma.client.$executeRaw`
      UPDATE woori.storage_cleanup_jobs SET "availableAt"=${available}, "lockedUntil"=NULL,
        "lockToken"=NULL, "updatedAt"=${now}
      WHERE id=${job.id}::uuid AND "lockToken"=${job.lockToken}::uuid`;
  }
  /** Finished or long-expired avatar upload reservations (bounded). */
  async purgeUploads(limit: number): Promise<number> {
    const before = new Date(Date.now() - AVATAR_UPLOAD_RETENTION_MS);
    return this.prisma.client.$executeRaw`
      DELETE FROM woori.avatar_uploads WHERE id IN (
        SELECT id FROM woori.avatar_uploads WHERE "createdAt" < ${before}
        ORDER BY "createdAt" LIMIT ${limit})`;
  }
}
