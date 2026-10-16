import { Prisma } from '@prisma/client';

// Deletes the recipient's notifications that contain any activity by `actorId`,
// so a later unblock does not resurrect them. A reaction bundle that also holds
// other reactors' activities is erased as a whole (W05 semantics kept: the
// blocker's notifications involving that user are gone, never restored).
// Lock order: the notification rows FOR NO KEY UPDATE in id order first, which
// fences bundle writers (they lock the same row before appending) without
// blocking push fanout's FK KEY SHARE; then, as in account deletion, the outbox
// events (fanout holds them FOR UPDATE), deliveries, activities and the rows.
export async function eraseNotificationsFromActor(
  tx: Prisma.TransactionClient,
  recipientId: string,
  actorId: string
) {
  const ids = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT n.id FROM woori.notifications n
      WHERE n."recipientId"=${recipientId}::uuid
        AND EXISTS (SELECT 1 FROM woori.notification_activities a WHERE a."notificationId"=n.id AND a."actorId"=${actorId}::uuid)
      ORDER BY n.id FOR NO KEY UPDATE OF n`
  ).map((row) => row.id);
  if (!ids.length) return 0;
  await tx.$executeRaw(
    Prisma.sql`DELETE FROM woori.outbox_events WHERE type='NOTIFICATION_PUSH' AND "aggregateId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`
  );
  await tx.notificationDelivery.deleteMany({
    where: { notificationId: { in: ids } },
  });
  await tx.notificationActivity.deleteMany({
    where: { notificationId: { in: ids } },
  });
  await tx.notification.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}
