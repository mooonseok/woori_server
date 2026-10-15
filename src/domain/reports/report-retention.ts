import type { Prisma } from '@prisma/client';

// Report retention policy on reporter account withdrawal: keep each report's
// target, reason and status anonymously for the operator, but erase the
// reporter's free-text detail immediately. Reports about the withdrawing user
// (targetUserId) are untouched. Purge timing is an operator decision (no auto
// purge yet). Call only inside the account deletion transaction after the user
// row is locked.
export async function anonymizeReportsOnAccountDeletion(
  tx: Prisma.TransactionClient,
  userId: string
) {
  await tx.contentReport.updateMany({
    where: { reporterId: userId },
    data: { detail: null, updatedAt: new Date() },
  });
}
