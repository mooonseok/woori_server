import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { hashToken } from './auth-token';
export function rateLimitKey(
  scope: string,
  value: string,
  now: Date,
  windowMs: number
) {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  return {
    id: hashToken(`${scope}:${windowStart.toISOString()}:${value}`),
    windowStart,
  };
}
export function tooManyRequests(): never {
  throw new HttpException(
    {
      code: 'TOO_MANY_REQUESTS',
      message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
    },
    429
  );
}
// Serializes one key's check-then-insert inside the caller's transaction across
// API replicas (count-based limits over stored rows). The key is hashed, so the
// lock id never carries a raw user id.
export async function lockRateLimitKey(
  tx: Prisma.TransactionClient,
  scope: string,
  value: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hashToken(`${scope}:${value}`)}, 0))`;
}
@Injectable()
export class AuthRateLimitService {
  constructor(private readonly prisma: PrismaService) {}
  async consume(key: string, limit: number, windowMs = 15 * 60 * 1000) {
    const { id, windowStart } = rateLimitKey('auth', key, new Date(), windowMs);
    // Native PostgreSQL UPSERT is atomic across workers and Railway replicas.
    const rows = await this.prisma.client.$queryRaw<
      Array<{ attempts: number }>
    >`
      INSERT INTO "woori"."rate_limit_buckets" ("id", "windowStart", "attempts")
      VALUES (${id}, ${windowStart}, 1)
      ON CONFLICT ("id") DO UPDATE SET "attempts" = "woori"."rate_limit_buckets"."attempts" + 1
      RETURNING "attempts"`;
    if (rows[0].attempts > limit) tooManyRequests();
  }
}
