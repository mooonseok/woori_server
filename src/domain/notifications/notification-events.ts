import type { Prisma } from '@prisma/client';
// Called inside the successful domain transaction. Preferences affect future push
// delivery only: the account inbox remains complete when push is muted.
export async function recordPhotoActivity(
  tx: Prisma.TransactionClient,
  photoId: string,
  actorId: string,
  kind: 'PHOTOS' | 'COMMENT' | 'PIN' | 'REACTION',
  targetId: string
) {
  const photo = await tx.photo.findUniqueOrThrow({
    where: { id: photoId },
    select: { groupId: true, uploaderId: true },
  });
  const recipients = await tx.membership.findMany({
    where: {
      groupId: photo.groupId,
      status: 'ACTIVE',
      userId:
        kind === 'PHOTOS'
          ? { not: actorId }
          : { equals: photo.uploaderId, not: actorId },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  // A reaction keeps one lifetime identity per photo/actor, even after toggling.
  const eventKey = `${kind}:${targetId}:${actorId}`;
  for (const { userId: recipientId } of recipients) {
    await tx.notification.createMany({
      data: [
        {
          recipientId,
          groupId: photo.groupId,
          kind,
          targetId,
          dedupeKey: eventKey,
        },
      ],
      skipDuplicates: true,
    });
    const notification = await tx.notification.findUniqueOrThrow({
      where: { recipientId_dedupeKey: { recipientId, dedupeKey: eventKey } },
      select: { id: true },
    });
    const activity = await tx.notificationActivity.createMany({
      data: [
        { notificationId: notification.id, actorId, sequence: 1, eventKey },
      ],
      skipDuplicates: true,
    });
    if (activity.count)
      await tx.outboxEvent.create({
        data: {
          eventKey: `push:${notification.id}:1`,
          type: 'NOTIFICATION_PUSH',
          aggregateId: notification.id,
          payload: { sequence: 1 },
        },
      });
  }
}
