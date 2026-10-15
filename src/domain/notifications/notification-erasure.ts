import { Prisma } from '@prisma/client';

// Deletes the recipient's notifications whose activity actor is `actorId`, so a
// later unblock does not resurrect them. Same order as account deletion: the
// outbox events first (push fanout holds them FOR UPDATE), then deliveries,
// activities and the notifications themselves.
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
      ORDER BY n.id`
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
