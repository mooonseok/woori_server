import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccountDeletionRepository } from './account-deletion.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { DeleteAccountDto } from './dto/auth.dto';
import { clearSessionCookie, hashToken, sessionToken } from './auth-token';
import { verifyPassword } from './password';
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly repository: AccountDeletionRepository,
    private readonly limits: AuthRateLimitService
  ) {}
  preview(userId: string) {
    return this.repository.preview(userId);
  }
  async delete(
    userId: string,
    dto: DeleteAccountDto,
    request: Request,
    response: Response
  ) {
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException();
    await this.limits.consume(`account-credentials:${userId}`, 10);
    const user = await this.repository.findUser(userId);
    if (
      !(await verifyPassword(dto.currentPassword, user?.passwordHash)) ||
      !user
    )
      throw new BadRequestException({
        code: 'INVALID_CURRENT_PASSWORD',
        message: '현재 비밀번호를 확인해 주세요.',
      });
    await this.repository.delete(userId, hashToken(token), user.passwordHash);
    clearSessionCookie(response);
  }
}
