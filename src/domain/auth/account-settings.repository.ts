import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { enqueueMail, MAIL_TTL_MS } from '../mail/mail-outbox';
import type { TokenMail } from './auth.repository';
import { revokeAccountCredentials } from './revoke-account-credentials';
@Injectable()
export class AccountSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}
  findUser(userId: string) {
    return this.prisma.client.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
    });
  }
  private async lockActor(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionHash: string,
    expectedHash?: string
  ) {
    await tx.$queryRaw`SELECT id FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM woori.sessions WHERE "tokenHash"=${sessionHash} AND "userId"=${userId}::uuid FOR UPDATE`;
    const session = await tx.session.findFirst({
      where: {
        tokenHash: sessionHash,
        userId,
        audience: 'web',
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE' },
      },
      include: { user: true },
    });
    if (
      !session ||
      (expectedHash && session.user.passwordHash !== expectedHash)
    )
      throw new UnauthorizedException();
    return session.user;
  }
  async changePassword(
    userId: string,
    sessionHash: string,
    expectedHash: string,
    passwordHash: string
  ) {
    await this.prisma.client.$transaction(async (tx) => {
      await this.lockActor(tx, userId, sessionHash, expectedHash);
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await revokeAccountCredentials(tx, userId);
    });
  }
  async requestEmail(
    userId: string,
    sessionHash: string,
    expectedHash: string,
    targetEmail: string,
    tokenHash: string,
    mail: TokenMail
  ) {
    await this.prisma.client.$transaction(async (tx) => {
      const user = await this.lockActor(tx, userId, sessionHash, expectedHash);
      if (user.email === targetEmail)
        throw new BadRequestException({
          code: 'EMAIL_UNCHANGED',
          message: '현재 이메일과 다른 주소를 입력해 주세요.',
        });
      if (
        await tx.user.findUnique({
          where: { email: targetEmail },
          select: { id: true },
        })
      )
        throw this.conflict();
      await tx.emailToken.updateMany({
        where: { userId, purpose: 'CHANGE_EMAIL', consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const created = await tx.emailToken.create({
        data: {
          userId,
          purpose: 'CHANGE_EMAIL',
          tokenHash,
          targetEmail,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      await enqueueMail(tx, {
        id: mail.id,
        kind: 'CHANGE_EMAIL',
        userId,
        emailTokenId: created.id,
        payload: { to: targetEmail, token: mail.token },
        expiresAt: created.expiresAt,
      });
    });
  }
  // noticeMailId: the previous-address notice is queued in the same
  // transaction as the change when mail is configured (a missing mail setup
  // never blocks the confirmation itself).
  async confirmEmail(
    userId: string,
    sessionHash: string,
    tokenHash: string,
    noticeMailId?: string
  ) {
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const user = await this.lockActor(tx, userId, sessionHash);
        const now = new Date();
        const token = await tx.emailToken.findUnique({ where: { tokenHash } });
        if (
          !token ||
          token.userId !== userId ||
          token.purpose !== 'CHANGE_EMAIL' ||
          !token.targetEmail ||
          token.consumedAt ||
          token.expiresAt <= now
        )
          throw new BadRequestException({
            code: 'INVALID_EMAIL_CHANGE_TOKEN',
            message:
              '이메일 변경 링크가 만료되었거나 사용할 수 없어요. 요청한 계정으로 로그인하거나 새 링크를 요청해 주세요.',
          });
        await tx.user.update({
          where: { id: userId },
          data: { email: token.targetEmail, verifiedAt: now },
        });
        await revokeAccountCredentials(tx, userId, now);
        if (noticeMailId)
          await enqueueMail(tx, {
            id: noticeMailId,
            kind: 'EMAIL_CHANGED_NOTICE',
            userId,
            payload: { to: user.email },
            expiresAt: new Date(
              now.getTime() + MAIL_TTL_MS.EMAIL_CHANGED_NOTICE
            ),
          });
        return {
          previousEmail: user.email,
          noticeQueued: Boolean(noticeMailId),
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw this.conflict();
      throw error;
    }
  }
  private conflict() {
    return new ConflictException({
      code: 'EMAIL_ALREADY_IN_USE',
      message: '이미 사용 중인 이메일이에요. 다른 주소를 입력해 주세요.',
    });
  }
}
