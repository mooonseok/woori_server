import type { Prisma } from '@prisma/client';

// Block retention policy on account withdrawal: the withdrawing user's own blocks
// (blockerId) are personal settings and are deleted. Blocks other members placed
// on the withdrawing user (blockedId) are kept, so that user's retained shared
// content stays hidden for them. Call only inside the account deletion
// transaction after the user row is locked.
export async function eraseBlocksOnAccountDeletion(
  tx: Prisma.TransactionClient,
  userId: string
) {
  await tx.userBlock.deleteMany({ where: { blockerId: userId } });
}
