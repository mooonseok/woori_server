import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { hashToken } from './auth-token';
export function rateLimitKey(scope: string, value: string, now: Date, windowMs: number) {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  return { id: hashToken(`${scope}:${windowStart.toISOString()}:${value}`), windowStart };
}
@Injectable()
export class AuthRateLimitService {
  constructor(private readonly prisma: PrismaService) {}
  async consume(key: string, limit: number, windowMs = 15 * 60 * 1000) {
    const { id, windowStart } = rateLimitKey('auth', key, new Date(), windowMs);
    // Native PostgreSQL UPSERT is atomic across workers and Railway replicas.
    const rows = await this.prisma.client.$queryRaw<Array<{ attempts: number }>>`
      INSERT INTO "woori"."rate_limit_buckets" ("id", "windowStart", "attempts")
      VALUES (${id}, ${windowStart}, 1)
      ON CONFLICT ("id") DO UPDATE SET "attempts" = "woori"."rate_limit_buckets"."attempts" + 1
      RETURNING "attempts"`;
    if (rows[0].attempts > limit) throw new HttpException({ code: 'TOO_MANY_REQUESTS', message: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.' }, 429);
  }
}
