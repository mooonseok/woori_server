import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { revokeAccountCredentials } from '../domain/auth/revoke-account-credentials';
// Shared suspension boundary (report resolution now, direct member actions in a
// later slice). Suspension blocks the member's own access only: status
// SUSPENDED and every session, push installation and outstanding email token is
// revoked atomically. Memberships, roles and shared content are kept.
// Lock order matches credential changes and account deletion: the user row,
// then its sessions/tokens/installations. Call inside the caller's transaction.
export async function suspendMember(
  tx: Prisma.TransactionClient,
  userId: string,
  now = new Date()
) {
  const rows = await tx.$queryRaw<
    { status: string }[]
  >`SELECT status::text AS status FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
  const previousStatus = rows[0]?.status;
  if (!previousStatus || previousStatus === 'DELETED')
    throw new ConflictException({
      code: 'ADMIN_USER_NOT_SUSPENDABLE',
      message: '탈퇴한 회원은 정지할 수 없어요.',
    });
  // Already suspended: idempotent, credentials were revoked at suspension.
  if (previousStatus === 'SUSPENDED') return { changed: false, previousStatus };
  await tx.user.update({
    where: { id: userId },
    data: { status: 'SUSPENDED' },
    select: { id: true },
  });
  await revokeAccountCredentials(tx, userId, now);
  return { changed: true, previousStatus };
}
// Restores access only: sessions, push installations and email tokens revoked at
// suspension stay revoked (the member signs in again).
export async function unsuspendMember(
  tx: Prisma.TransactionClient,
  userId: string
) {
  const rows = await tx.$queryRaw<
    { status: string }[]
  >`SELECT status::text AS status FROM woori.users WHERE id=${userId}::uuid FOR UPDATE`;
  if (rows[0]?.status !== 'SUSPENDED')
    throw new ConflictException({
      code: 'ADMIN_USER_NOT_SUSPENDED',
      message: '정지된 회원이 아니에요.',
    });
  await tx.user.update({
    where: { id: userId },
    data: { status: 'ACTIVE' },
    select: { id: true },
  });
}
