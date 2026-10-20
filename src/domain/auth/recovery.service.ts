import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request } from 'express';
import { RecoveryRepository } from './recovery.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { MailOutboxService, requireMailConfigured } from '../mail/mail-outbox';
import { createToken, hashToken } from './auth-token';
import { hashPassword } from './password';
import { publicUser } from './auth.service';
import type { RecoveryRequestDto, ResetPasswordDto } from './dto/auth.dto';

@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  constructor(
    private readonly repository: RecoveryRepository,
    private readonly limits: AuthRateLimitService,
    private readonly outbox: MailOutboxService
  ) {}
  async request(
    kind: 'username' | 'password',
    dto: RecoveryRequestDto,
    request: Request
  ) {
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    await this.limits.consume(`recovery-ip:${ip}`, 30, 60 * 60 * 1000);
    await this.limits.consume(
      `recovery-${kind}:${hashToken(dto.email)}`,
      5,
      60 * 60 * 1000
    );
    // Same envelope on absent/disabled/mismatched accounts and delivery failure.
    // A common floor covers the bounded provider attempt; no account data in responses/logs.
    await Promise.all([
      delay(3000),
      (async () => {
        try {
          requireMailConfigured();
          const user = await this.repository.findAccount(dto.name, dto.email);
          if (!user) return;
          // Queued with the token in one transaction, tried now, retried by
          // the worker; the response never depends on delivery.
          if (kind === 'username') {
            const id = randomUUID();
            if (
              await this.repository.issueUsername(
                user.id,
                dto.name,
                dto.email,
                id
              )
            )
              await this.outbox.dispatch(id);
          } else {
            const token = createToken();
            const mail = { id: randomUUID(), token };
            if (
              await this.repository.issue(
                user.id,
                dto.name,
                dto.email,
                hashToken(token),
                mail
              )
            )
              await this.outbox.dispatch(mail.id);
          }
        } catch {
          // Keep a possibly delivered reset token valid after provider timeout.
          this.logger.warn(
            'Recovery request could not be completed; no recipient or token logged.'
          );
        }
      })(),
    ]);
    return { accepted: true };
  }
  async reset(dto: ResetPasswordDto, request: Request) {
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    await this.limits.consume(`recovery-confirm-ip:${ip}`, 30);
    await this.limits.consume(
      `recovery-confirm-token:${hashToken(dto.token)}`,
      5
    );
    await this.repository.reset(
      hashToken(dto.token),
      await hashPassword(dto.newPassword)
    );
  }
  async profile(
    userId: string,
    profile: { displayName?: string; nickname?: string }
  ) {
    await this.limits.consume(`profile:${userId}`, 20);
    return {
      user: publicUser(await this.repository.profile(userId, profile)),
    };
  }
}
