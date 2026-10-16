import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  adminConfig,
  type AdminConfig,
} from '../../common/configurations/admin.config';
import {
  AdminAuthService,
  adminAuthenticationRequired,
  adminNotConfigured,
} from '../admin-auth.service';
import { adminAccessError, type AdminAccessLevel } from '../admin-policy';
import {
  ADMIN_ACCESS,
  ADMIN_REAUTH,
} from '../decorators/admin-access.decorator';
import type { AdminRequest } from '../dto/admin-session.dto';
const SAFE_METHODS = ['GET', 'HEAD'];
// Admin requests must come from the admin web only. Every admin request
// (including audited GETs) carries X-Woori-Request: 1, which a cross-site page
// cannot add without a CORS preflight that only ADMIN_WEB_ORIGIN passes. A
// present Origin must be the admin web origin (the member web origin is
// rejected for every method) and mutations must send it. OPTIONS preflights
// are answered by the CORS layer before any guard.
export function checkAdminOrigin(request: Request, config: AdminConfig) {
  const origin = request.get('Origin');
  const mutation = !SAFE_METHODS.includes(request.method);
  if (
    request.get('X-Woori-Request') !== '1' ||
    (origin !== undefined && origin !== config.webOrigin) ||
    (mutation && origin !== config.webOrigin)
  )
    throw new ForbiddenException({
      code: 'REQUEST_ORIGIN_REJECTED',
      message: '허용되지 않은 요청이에요. 관리자 화면에서 다시 시도해 주세요.',
    });
}
// Order: configuration (503) → admin session (401) → origin (403) → MFA and
// re-authentication requirements (403). Member sessions are never consulted.
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuthService
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = adminConfig() ?? adminNotConfigured();
    const targets = [context.getHandler(), context.getClass()];
    const level =
      this.reflector.getAllAndOverride<AdminAccessLevel>(
        ADMIN_ACCESS,
        targets
      ) ?? 'verified';
    const reauth = Boolean(
      this.reflector.getAllAndOverride<boolean>(ADMIN_REAUTH, targets)
    );
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (level === 'public') {
      checkAdminOrigin(request, config);
      return true;
    }
    const session = await this.auth.resolveSession(request);
    if (!session) adminAuthenticationRequired();
    checkAdminOrigin(request, config);
    const now = new Date();
    const error = adminAccessError(session, level, reauth, now);
    if (error === 'ADMIN_MFA_REQUIRED')
      throw new ForbiddenException({
        code: error,
        message: '2단계 인증을 먼저 완료해 주세요.',
      });
    if (error === 'ADMIN_REAUTH_REQUIRED')
      throw new ForbiddenException({
        code: error,
        message: '보안을 위해 비밀번호와 인증 코드를 다시 확인해 주세요.',
      });
    await this.auth.touch(session, now);
    request.adminSession = session;
    return true;
  }
}
