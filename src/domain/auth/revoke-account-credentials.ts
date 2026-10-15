import { Prisma } from '@prisma/client';
// Caller must hold the user row lock before invoking this shared credential boundary.
export async function revokeAccountCredentials(
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date()
) {
  await tx.emailToken.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: now },
  });
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.pushInstallation.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, enabled: false, bindingVersion: { increment: 1 } },
  });
}
