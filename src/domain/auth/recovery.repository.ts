import { revokeAccountCredentials } from './revoke-account-credentials';
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../common/modules/prisma/prisma.service';

const PURPOSE = 'RESET_PASSWORD';
// A suspended member may still recover the username or reset the password (the
// reset revokes credentials and never creates a session); login keeps answering
// 403 ACCOUNT_SUSPENDED and nothing here changes the account status.
const RECOVERABLE = { in: ['ACTIVE' as const, 'SUSPENDED' as const] };
@Injectable()
export class RecoveryRepository {
  constructor(private readonly prisma: PrismaService) {}
  findAccount(name: string, email: string) {
    return this.prisma.client.user.findFirst({
      where: { displayName: name, email, status: RECOVERABLE },
    });
  }
  async issue(userId: string, name: string, email: string, tokenHash: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({
        where: { id: userId, displayName: name, email, status: RECOVERABLE },
      });
      if (!user) return false;
      await tx.emailToken.updateMany({
        where: { userId, purpose: PURPOSE, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.emailToken.create({
        data: {
          userId,
          purpose: PURPOSE,
          tokenHash,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      return true;
    });
  }
  async reset(tokenHash: string, passwordHash: string) {
    await this.prisma.client.$transaction(async (tx) => {
      const initial = await tx.emailToken.findUnique({ where: { tokenHash } });
      if (!initial || initial.purpose !== PURPOSE) throw this.invalid();
      // All issue/reset/login operations serialize on the user before touching tokens/sessions.
      await tx.$queryRaw`SELECT id FROM woori.users WHERE id=${initial.userId}::uuid FOR UPDATE`;
      const now = new Date();
      const user = await tx.user.findFirst({
        where: { id: initial.userId, status: RECOVERABLE },
      });
      if (!user) throw this.invalid();
      const used = await tx.emailToken.updateMany({
        where: {
          id: initial.id,
          purpose: PURPOSE,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (used.count !== 1) throw this.invalid();
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await revokeAccountCredentials(tx, user.id, now);
    });
  }
  async profile(userId: string, displayName: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
      const updated = await tx.user.updateMany({
        where: { id: userId, status: 'ACTIVE' },
        data: { displayName },
      });
      if (!updated.count) throw new UnauthorizedException();
      return tx.user.findUniqueOrThrow({ where: { id: userId } });
    });
  }
  private invalid() {
    return new BadRequestException({
      code: 'INVALID_RECOVERY_TOKEN',
      message:
        '링크가 만료되었거나 이미 사용됐어요. 새 재설정 링크를 요청해 주세요.',
    });
  }
}
