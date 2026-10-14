import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import type { Request, Response } from 'express';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { AuthRepository } from './auth.repository';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { MailService } from './mail.service';
import { LoginDto, SignupDto } from './dto/auth.dto';
import {
  clearSessionCookie,
  createToken,
  hashToken,
  sessionToken,
  setSessionCookie,
} from './auth-token';
import { hashPassword, verifyPassword } from './password';
export function publicUser(user: User): SessionUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    emailVerified: Boolean(user.verifiedAt),
  };
}
@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly limits: AuthRateLimitService,
    private readonly mail: MailService
  ) {}
  async signup(dto: SignupDto, request: Request, response: Response) {
    await this.limits.consume(
      `signup-ip:${this.ip(request)}`,
      20,
      60 * 60 * 1000
    );
    await this.limits.consume(`signup-email:${dto.email}`, 5, 60 * 60 * 1000);
    const passwordHash = await hashPassword(dto.password);
    const token = createToken();
    let user: User;
    try {
      user = await this.repository.createUser(
        {
          username: dto.username,
          email: dto.email,
          displayName: dto.displayName,
          passwordHash,
        },
        hashToken(token)
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictException({
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: '이미 사용 중인 아이디 또는 이메일이에요.',
        });
      throw error;
    }
    await this.rotateCookie(request, response, token);
    let verificationDelivery: 'sent' | 'unavailable' = 'sent';
    try {
      await this.sendVerification(user.id, user.email);
    } catch {
      verificationDelivery = 'unavailable';
    }
    return { user: publicUser(user), verificationDelivery };
  }
  async login(dto: LoginDto, request: Request, response: Response) {
    await this.limits.consume(`login-ip:${this.ip(request)}`, 60);
    await this.limits.consume(`login-name:${dto.username}`, 10);
    const user = await this.repository.findByUsername(dto.username);
    const correct = await verifyPassword(dto.password, user?.passwordHash);
    if (!user || !correct || user.status !== 'ACTIVE')
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: '아이디와 비밀번호를 확인해 주세요.',
      });
    const token = createToken();
    await this.repository.createSession(user.id, hashToken(token));
    await this.rotateCookie(request, response, token);
    return { user: publicUser(user) };
  }
  async logout(request: Request, response: Response) {
    const token = sessionToken(request);
    if (token) await this.repository.revokeSession(hashToken(token));
    clearSessionCookie(response);
  }
  async resolveSession(request: Request): Promise<SessionUser | undefined> {
    const token = sessionToken(request);
    if (!token) return undefined;
    const session = await this.repository.findSession(hashToken(token));
    return session ? publicUser(session.user) : undefined;
  }
  async requestVerification(user: SessionUser) {
    await this.limits.consume(
      `verification-user:${user.id}`,
      3,
      60 * 60 * 1000
    );
    if (!user.emailVerified) {
      try {
        await this.sendVerification(user.id, user.email);
      } catch {
        throw new ServiceUnavailableException({
          code: 'MAIL_DELIVERY_UNAVAILABLE',
          message: '메일을 보내지 못했어요. 잠시 후 다시 요청해 주세요.',
        });
      }
    }
    return { accepted: true };
  }
  async confirmVerification(user: SessionUser, token: string) {
    await this.limits.consume(`verification-confirm:${user.id}`, 20);
    return {
      user: publicUser(
        await this.repository.verifyEmail(hashToken(token), user.id)
      ),
    };
  }
  private async sendVerification(userId: string, email: string) {
    const token = createToken();
    await this.repository.createEmailToken(userId, hashToken(token));
    await this.mail.sendVerification(email, token);
  }
  private async rotateCookie(
    request: Request,
    response: Response,
    token: string
  ) {
    const previous = sessionToken(request);
    if (previous) await this.repository.revokeSession(hashToken(previous));
    setSessionCookie(response, token);
  }
  private ip(request: Request) {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
