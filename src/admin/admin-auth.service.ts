import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { adminConfig } from '../common/configurations/admin.config';
import { AuthRateLimitService } from '../domain/auth/auth-rate-limit.service';
import { createToken, hashToken } from '../domain/auth/auth-token';
import { verifyPassword } from '../domain/auth/password';
import { AdminAuthRepository } from './admin-auth.repository';
import {
  ADMIN_LOGIN_IP_LIMIT,
  ADMIN_LOGIN_USERNAME_LIMIT,
  ADMIN_MFA_IP_LIMIT,
  ADMIN_RATE_WINDOW_MS,
  adminMfaState,
  isAdminLocked,
  nextIdleExpiry,
  reauthValidUntil,
} from './admin-policy';
import {
  adminSessionToken,
  clearAdminSessionCookie,
  setAdminSessionCookie,
} from './admin-session-token';
import type { AdminSessionContext } from './dto/admin-session.dto';
import type {
  AdminLoginDto,
  AdminMfaCodeDto,
  AdminReauthDto,
} from './dto/admin-auth.dto';
import {
  encryptTotpSecret,
  generateTotpSecret,
  base32Encode,
  otpauthUri,
} from './totp';

export function adminNotConfigured(): never {
  throw new ServiceUnavailableException({
    code: 'ADMIN_NOT_CONFIGURED',
    message: '관리자 기능이 설정되지 않았어요.',
  });
}
export function adminAuthenticationRequired(): never {
  throw new UnauthorizedException({
    code: 'ADMIN_AUTHENTICATION_REQUIRED',
    message: '관리자 로그인이 필요해요.',
  });
}
// One generic answer for unknown account, wrong password, disabled or locked
// account, and any failed re-authentication factor.
function invalidCredentials(): never {
  throw new UnauthorizedException({
    code: 'ADMIN_INVALID_CREDENTIALS',
    message: '아이디와 비밀번호를 확인해 주세요.',
  });
}
function mfaInvalid(): never {
  throw new UnauthorizedException({
    code: 'ADMIN_MFA_INVALID',
    message:
      '인증 코드를 확인해 주세요. 계속 실패하면 잠시 후 다시 로그인해 주세요.',
  });
}
function conflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}
export function adminMe(session: AdminSessionContext, now = new Date()) {
  return {
    admin: session.admin,
    mfa: adminMfaState(session.totpEnabled, session.mfaVerifiedAt),
    sessionExpiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
    reauthValidUntil: reauthValidUntil(session.reauthAt, now),
  };
}
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly repository: AdminAuthRepository,
    private readonly limits: AuthRateLimitService
  ) {}
  private key() {
    return adminConfig()?.totpEncryptionKey ?? adminNotConfigured();
  }
  async login(dto: AdminLoginDto, request: Request, response: Response) {
    await this.limits.consume(
      `admin-login-ip:${this.ip(request)}`,
      ADMIN_LOGIN_IP_LIMIT,
      ADMIN_RATE_WINDOW_MS
    );
    // The limiter stores only a hash of the scoped key, never the username.
    await this.limits.consume(
      `admin-login-name:${dto.username}`,
      ADMIN_LOGIN_USERNAME_LIMIT,
      ADMIN_RATE_WINDOW_MS
    );
    const account = await this.repository.findLoginAccount(dto.username);
    // Unknown accounts pay the same scrypt cost.
    const correct = await verifyPassword(dto.password, account?.passwordHash);
    const now = new Date();
    if (!account) {
      await this.repository.recordLoginFailure(null, 'UNKNOWN_ACCOUNT', now);
      invalidCredentials();
    }
    if (
      !correct ||
      account.status !== 'ACTIVE' ||
      isAdminLocked(account.lockedUntil, now)
    ) {
      await this.repository.recordLoginFailure(
        account.id,
        correct ? 'LOCKED' : 'WRONG_PASSWORD',
        now
      );
      invalidCredentials();
    }
    const token = createToken();
    const previous = adminSessionToken(request);
    const session = await this.repository.createPreMfaSession(
      account.id,
      account.passwordHash,
      hashToken(token),
      previous ? hashToken(previous) : undefined,
      now
    );
    if (!session) {
      await this.repository.recordLoginFailure(account.id, 'LOCKED', now);
      invalidCredentials();
    }
    setAdminSessionCookie(response, token, session.expiresAt, now);
    return {
      admin: session.admin,
      mfa: adminMfaState(session.totpEnabled, null),
    };
  }
  // Resolves the admin cookie. Verified sessions slide their idle deadline at
  // most once per minute.
  async resolveSession(request: Request) {
    const token = adminSessionToken(request);
    if (!token) return undefined;
    const now = new Date();
    return (
      (await this.repository.findActiveSession(hashToken(token), now)) ??
      undefined
    );
  }
  async touch(session: AdminSessionContext, now = new Date()) {
    const next = nextIdleExpiry(session, now);
    if (!next) return;
    await this.repository.slideIdleExpiry(session.sessionId, next);
    session.idleExpiresAt = next;
  }
  async setupMfa(session: AdminSessionContext) {
    if (session.mfaVerifiedAt)
      conflict('ADMIN_MFA_ALREADY_VERIFIED', '이미 2단계 인증을 마쳤어요.');
    if (session.totpEnabled)
      conflict('ADMIN_MFA_ALREADY_ENABLED', '이미 인증 앱이 등록되어 있어요.');
    const secret = generateTotpSecret();
    const result = await this.repository.storePendingTotpSecret(
      session,
      encryptTotpSecret(secret, this.key(), session.admin.id),
      new Date()
    );
    if (result === 'unauthenticated') adminAuthenticationRequired();
    if (result === 'already-verified')
      conflict('ADMIN_MFA_ALREADY_VERIFIED', '이미 2단계 인증을 마쳤어요.');
    if (result === 'already-enabled')
      conflict('ADMIN_MFA_ALREADY_ENABLED', '이미 인증 앱이 등록되어 있어요.');
    // Shown once for enrolment; only the ciphertext is stored.
    return {
      secret: base32Encode(secret),
      otpauthUri: otpauthUri(session.admin.username, secret),
    };
  }
  async completeMfa(
    stage: 'ACTIVATE' | 'VERIFY',
    session: AdminSessionContext,
    dto: AdminMfaCodeDto,
    request: Request,
    response: Response
  ) {
    await this.limits.consume(
      `admin-mfa-ip:${this.ip(request)}`,
      ADMIN_MFA_IP_LIMIT,
      ADMIN_RATE_WINDOW_MS
    );
    const token = createToken();
    const now = new Date();
    const result = await this.repository.completeMfa(
      stage,
      session,
      dto.code,
      this.key(),
      hashToken(token),
      now
    );
    switch (result.kind) {
      case 'ok':
        // Privilege elevation rotates the session token.
        setAdminSessionCookie(response, token, result.context.expiresAt, now);
        return adminMe(result.context, now);
      case 'unauthenticated':
        return adminAuthenticationRequired();
      case 'already-verified':
        return conflict(
          'ADMIN_MFA_ALREADY_VERIFIED',
          '이미 2단계 인증을 마쳤어요.'
        );
      case 'already-enabled':
        return conflict(
          'ADMIN_MFA_ALREADY_ENABLED',
          '이미 인증 앱이 등록되어 있어요.'
        );
      case 'setup-required':
        return conflict(
          'ADMIN_MFA_SETUP_REQUIRED',
          '먼저 인증 앱을 등록해 주세요.'
        );
      case 'invalid':
        if (result.sessionRevoked) clearAdminSessionCookie(response);
        return mfaInvalid();
    }
  }
  async reauthenticate(
    session: AdminSessionContext,
    dto: AdminReauthDto,
    request: Request,
    response: Response
  ) {
    await this.limits.consume(
      `admin-mfa-ip:${this.ip(request)}`,
      ADMIN_MFA_IP_LIMIT,
      ADMIN_RATE_WINDOW_MS
    );
    const account = await this.repository.findLoginAccount(
      session.admin.username
    );
    const correct = await verifyPassword(dto.password, account?.passwordHash);
    if (!account || account.id !== session.admin.id)
      adminAuthenticationRequired();
    const now = new Date();
    const result = await this.repository.reauthenticate(
      session,
      account.passwordHash,
      correct,
      dto.code,
      this.key(),
      now
    );
    if (result.kind === 'unauthenticated') adminAuthenticationRequired();
    if (result.kind === 'invalid') {
      if (result.sessionRevoked) clearAdminSessionCookie(response);
      invalidCredentials();
    }
    return adminMe(result.context, now);
  }
  async logout(request: Request, response: Response) {
    const token = adminSessionToken(request);
    if (token) await this.repository.logout(hashToken(token), new Date());
    clearAdminSessionCookie(response);
  }
  private ip(request: Request) {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
