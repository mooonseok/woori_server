import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccountSettingsRepository } from './account-settings.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { MailService } from './mail.service';
import { ChangePasswordDto, RequestEmailChangeDto } from './dto/auth.dto';
import {
  clearSessionCookie,
  createToken,
  hashToken,
  sessionToken,
} from './auth-token';
import { hashPassword, verifyPassword } from './password';
@Injectable()
export class AccountSettingsService {
  private readonly logger = new Logger(AccountSettingsService.name);
  constructor(
    private readonly repository: AccountSettingsRepository,
    private readonly limits: AuthRateLimitService,
    private readonly mail: MailService
  ) {}
  private session(request: Request) {
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException();
    return hashToken(token);
  }
  private async credentials(userId: string, currentPassword: string) {
    await this.limits.consume(`account-credentials:${userId}`, 10);
    const user = await this.repository.findUser(userId);
    if (!(await verifyPassword(currentPassword, user?.passwordHash)) || !user)
      throw new BadRequestException({
        code: 'INVALID_CURRENT_PASSWORD',
        message: '현재 비밀번호를 확인해 주세요.',
      });
    return user;
  }
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    request: Request,
    response: Response
  ) {
    const sessionHash = this.session(request);
    const user = await this.credentials(userId, dto.currentPassword);
    if (dto.currentPassword === dto.newPassword)
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: '현재 비밀번호와 다른 비밀번호를 입력해 주세요.',
      });
    await this.repository.changePassword(
      userId,
      sessionHash,
      user.passwordHash,
      await hashPassword(dto.newPassword)
    );
    clearSessionCookie(response);
  }
  async requestEmail(
    userId: string,
    dto: RequestEmailChangeDto,
    request: Request
  ) {
    const sessionHash = this.session(request);
    const user = await this.credentials(userId, dto.currentPassword);
    await this.limits.consume(
      `email-change-request:${userId}`,
      5,
      60 * 60 * 1000
    );
    const token = createToken();
    await this.repository.requestEmail(
      userId,
      sessionHash,
      user.passwordHash,
      dto.newEmail,
      hashToken(token)
    );
    try {
      await this.mail.sendEmailChange(dto.newEmail, token);
    } catch {
      throw new ServiceUnavailableException({
        code: 'MAIL_DELIVERY_UNAVAILABLE',
        message: '메일을 보내지 못했어요. 잠시 후 다시 요청해 주세요.',
      });
    }
    return { accepted: true };
  }
  async confirmEmail(
    userId: string,
    token: string,
    request: Request,
    response: Response
  ) {
    await this.limits.consume(`email-change-confirm:${userId}`, 20);
    const result = await this.repository.confirmEmail(
      userId,
      this.session(request),
      hashToken(token)
    );
    clearSessionCookie(response);
    try {
      await this.mail.sendEmailChangedNotice(result.previousEmail);
    } catch {
      this.logger.warn(
        'Email-change notice delivery failed; no recipient or token logged.'
      );
    }
  }
}
