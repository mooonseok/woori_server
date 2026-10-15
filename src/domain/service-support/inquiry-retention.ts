import type { Prisma } from '@prisma/client';

// Inquiry retention policy on account withdrawal: inquiries are personal records
// of the withdrawing member and are removed immediately with the account data.
// Call only inside the account deletion transaction after the user row is locked.
// Change the retention policy here (e.g. anonymize for a support audit period).
export async function eraseInquiriesOnAccountDeletion(
  tx: Prisma.TransactionClient,
  userId: string
) {
  await tx.inquiry.deleteMany({ where: { userId } });
}
