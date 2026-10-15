import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { hashToken, sessionToken } from '../auth/auth-token';
import { BLOCK_CHANGE_LIMIT, BLOCK_CHANGE_WINDOW_MS } from './block-policy';
import { BlocksRepository } from './blocks.repository';
function selfBlock(): never {
  throw new BadRequestException({
    code: 'BLOCK_SELF_NOT_ALLOWED',
    message: '본인은 차단할 수 없어요.',
  });
}
@Injectable()
export class BlocksService {
  constructor(
    private readonly repository: BlocksRepository,
    private readonly limits: AuthRateLimitService
  ) {}
  private consume(userId: string) {
    return this.limits.consume(
      `user-block:${userId}`,
      BLOCK_CHANGE_LIMIT,
      BLOCK_CHANGE_WINDOW_MS
    );
  }
  // Path ids are compared as text before reaching the database, so normalize
  // the accepted UUID spelling first (an uppercase own id is still "self").
  async block(userId: string, rawTargetId: string, request: Request) {
    const targetId = rawTargetId.toLowerCase();
    if (userId === targetId) selfBlock();
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException();
    await this.consume(userId);
    return this.repository.block(userId, targetId, hashToken(token));
  }
  async unblock(userId: string, rawTargetId: string) {
    const targetId = rawTargetId.toLowerCase();
    if (userId === targetId) selfBlock();
    await this.consume(userId);
    await this.repository.unblock(userId, targetId);
  }
  list(userId: string, limit: number, cursor?: string) {
    return this.repository.list(userId, limit, cursor);
  }
}
