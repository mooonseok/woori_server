import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { SESSION_TTL_MS } from './auth-token';
@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}
  findByUsername(username: string) { return this.prisma.client.user.findUnique({ where: { username } }); }
  async createUser(data: Prisma.UserCreateInput, tokenHash: string) {
    return this.prisma.client.$transaction(async tx => {
      const user = await tx.user.create({ data });
      await tx.session.create({ data: { userId: user.id, tokenHash, audience: 'web', expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
      return user;
    });
  }
  async createSession(userId: string, tokenHash: string) {
    return this.prisma.client.session.create({ data: { userId, tokenHash, audience: 'web', expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  }
  async findSession(tokenHash: string) {
    return this.prisma.client.session.findFirst({ where: { tokenHash, audience: 'web', revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } }, include: { user: true } });
  }
  async revokeSession(tokenHash: string) {
    await this.prisma.client.session.updateMany({ where: { tokenHash, audience: 'web', revokedAt: null }, data: { revokedAt: new Date() } });
  }
  async createEmailToken(userId: string, tokenHash: string) {
    await this.prisma.client.emailToken.create({ data: { userId, tokenHash, purpose: 'VERIFY_EMAIL', expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
  }
  async verifyEmail(tokenHash: string, userId: string): Promise<User> {
    return this.prisma.client.$transaction(async tx => {
      const now = new Date();
      const token = await tx.emailToken.findUnique({ where: { tokenHash } });
      if (!token || token.userId !== userId || token.purpose !== 'VERIFY_EMAIL' || token.consumedAt || token.expiresAt <= now) throw this.invalidToken();
      const consumed = await tx.emailToken.updateMany({ where: { id: token.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (consumed.count !== 1) throw this.invalidToken();
      const updated = await tx.user.updateMany({ where: { id: userId, status: 'ACTIVE' }, data: { verifiedAt: now } });
      if (updated.count !== 1) throw this.invalidToken();
      return tx.user.findUniqueOrThrow({ where: { id: userId } });
    });
  }
  private invalidToken() { return new BadRequestException({ code: 'INVALID_VERIFICATION_TOKEN', message: '인증 링크가 만료되었거나 사용할 수 없어요. 현재 계정에서 새 링크를 요청해 주세요.' }); }
}
