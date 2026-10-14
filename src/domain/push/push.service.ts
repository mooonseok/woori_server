import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { webPushConfig } from '../../common/push/web-push.config';
import {
  endpointHash,
  encryptSubscription,
  validateEndpoint,
  validateSubscription,
} from '../../common/push/push-subscription';
import { hashToken, sessionToken } from '../auth/auth-token';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { PushDispatchRepository } from '../../worker/push/push-dispatch.repository';
import { PushRepository } from './push.repository';
import type { PushSubscriptionDto } from './dto/push.dto';
@Injectable()
export class PushService {
  constructor(
    private readonly repository: PushRepository,
    private readonly dispatch: PushDispatchRepository,
    private readonly limits: AuthRateLimitService
  ) {}
  config() {
    const config = webPushConfig();
    return { enabled: Boolean(config), publicKey: config?.publicKey ?? null };
  }
  private token(request: Request) {
    const token = sessionToken(request);
    if (!token) throw new UnauthorizedException();
    return hashToken(token);
  }
  async register(userId: string, request: Request, dto: PushSubscriptionDto) {
    await this.limits.consume(`push-register:${userId}`, 30);
    const config = webPushConfig();
    if (!config)
      throw new ServiceUnavailableException({
        code: 'PUSH_NOT_CONFIGURED',
        message: '알림 연결이 아직 준비되지 않았어요.',
      });
    validateSubscription(dto);
    const expiresAt =
      dto.expirationTime == null ? null : new Date(dto.expirationTime);
    if (
      expiresAt &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
    )
      throw new BadRequestException({ code: 'PUSH_SUBSCRIPTION_EXPIRED' });
    return this.repository.register(
      userId,
      this.token(request),
      endpointHash(dto.endpoint),
      encryptSubscription(
        { endpoint: dto.endpoint, keys: dto.keys },
        config.encryptionKey
      ),
      expiresAt
    );
  }
  status(userId: string, request: Request, endpoint: string) {
    validateEndpoint(endpoint);
    return this.repository.status(
      userId,
      this.token(request),
      endpointHash(endpoint)
    );
  }
  revoke(userId: string, request: Request, id: string) {
    return this.repository.revoke(userId, this.token(request), id);
  }
  async display(userId: string, request: Request, id: string) {
    if (!webPushConfig()) throw new NotFoundException();
    const current = await this.dispatch.eligibility(id, {
      userId,
      tokenHash: this.token(request),
    });
    if (!current || current.decision.action !== 'send')
      throw new NotFoundException();
    const { row, delivery, preview } = current;
    const action =
      {
        PHOTOS: '새 사진을 올렸어요.',
        COMMENT: '내 사진에 댓글을 남겼어요.',
        PIN: '내 사진에 위치 댓글을 남겼어요.',
        REACTION: '내 사진에 반응했어요.',
      }[row.kind] ?? '새 소식이 있어요.';
    return {
      title: '우리',
      body: preview
        ? `${row.actorName}님이 ${action}`
        : '가족의 새로운 소식이 있어요.',
      tag: `woori-${row.id}`,
      notificationId: row.id,
      recipientId: delivery.notification.recipientId,
      installationId: delivery.installationId,
      url: `/notifications?notificationId=${row.id}`,
    };
  }
}
