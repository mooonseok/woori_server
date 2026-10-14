import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
@Injectable()
export class PushRepository {
  constructor(private readonly prisma: PrismaService) {}
  private async session(
    tx: Prisma.TransactionClient,
    userId: string,
    tokenHash: string
  ) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT s.id FROM woori.sessions s JOIN woori.users u ON u.id=s."userId" WHERE s."userId"=${userId}::uuid AND s."tokenHash"=${tokenHash} AND s.audience='web' AND s."revokedAt" IS NULL AND s."expiresAt">now() AND u.status='ACTIVE' FOR SHARE OF s`;
    if (!rows.length) throw new UnauthorizedException();
    return rows[0].id;
  }
  register(
    userId: string,
    tokenHash: string,
    hash: string,
    ciphertext: string,
    expiresAt: Date | null
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const sessionId = await this.session(tx, userId, tokenHash);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hash}, 0))`;
      const existing = await tx.pushInstallation.findUnique({
        where: { endpointHash: hash },
      });
      const same =
        existing?.userId === userId &&
        existing.sessionId === sessionId &&
        existing.enabled &&
        !existing.revokedAt;
      const data = {
        userId,
        sessionId,
        provider: 'WEB',
        endpointCiphertext: ciphertext,
        enabled: true,
        revokedAt: null,
        expiresAt,
      };
      const installation = await tx.pushInstallation.upsert({
        where: { endpointHash: hash },
        create: { ...data, endpointHash: hash },
        update: {
          ...data,
          ...(same
            ? {}
            : { bindingVersion: { increment: 1 }, boundAt: new Date() }),
        },
      });
      return { installationId: installation.id, enabled: true };
    });
  }
  status(userId: string, tokenHash: string, endpointHash: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const sessionId = await this.session(tx, userId, tokenHash);
      const installation = await tx.pushInstallation.findFirst({
        where: {
          userId,
          sessionId,
          endpointHash,
          enabled: true,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      return {
        installationId: installation?.id ?? null,
        enabled: Boolean(installation),
      };
    });
  }
  revoke(userId: string, tokenHash: string, id: string) {
    return this.prisma.client.$transaction(async (tx) => {
      const sessionId = await this.session(tx, userId, tokenHash);
      const changed = await tx.pushInstallation.updateMany({
        where: { id, userId, sessionId },
        data: {
          enabled: false,
          revokedAt: new Date(),
          bindingVersion: { increment: 1 },
        },
      });
      if (!changed.count) throw new NotFoundException();
    });
  }
}
