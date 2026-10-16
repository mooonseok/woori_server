import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { notBlocking } from '../blocks/block-visibility';
import {
  acceptsActivity,
  bundleKey,
  followUpPushAt,
  isBundledKind,
  openBundle,
  type BundledKind,
} from './notification-bundles';
// Called inside the successful domain transaction. Preferences affect future push
// delivery only: the account inbox remains complete when push is muted.
//
// Lock order (W07): the caller's domain locks (group -> membership/user -> album
// -> photo [-> comment/reaction]) -> `notification-bundle:<key>` advisory xact
// lock -> per recipient in userId order: that recipient's open bundle row
// FOR NO KEY UPDATE -> its waiting push outbox row FOR UPDATE SKIP LOCKED (never
// waits). Erasure locks notification rows FOR NO KEY UPDATE before deleting their
// outbox/delivery/activity rows, and fanout only takes FK KEY SHARE locks on
// notifications, so neither can form a cycle with this path.
export async function recordPhotoActivity(
  tx: Prisma.TransactionClient,
  photoId: string,
  actorId: string,
  kind: 'PHOTOS' | 'COMMENT' | 'PIN' | 'REACTION',
  targetId: string
) {
  const photo = await tx.photo.findUniqueOrThrow({
    where: { id: photoId },
    select: { groupId: true, uploaderId: true, albumId: true },
  });
  const recipients = await tx.membership.findMany({
    where: {
      groupId: photo.groupId,
      status: 'ACTIVE',
      userId:
        kind === 'PHOTOS'
          ? { not: actorId }
          : { equals: photo.uploaderId, not: actorId },
      // A recipient who blocked the actor gets no inbox row or push for it.
      user: { status: 'ACTIVE', ...notBlocking(actorId) },
    },
    select: { userId: true },
    orderBy: { userId: 'asc' },
  });
  // A reaction keeps one lifetime identity per photo/actor, even after toggling.
  const eventKey = `${kind}:${targetId}:${actorId}`;
  if (isBundledKind(kind)) {
    if (!recipients.length) return;
    const key = bundleKey(kind, {
      albumId: photo.albumId,
      actorId,
      photoId,
    });
    // Serializes every writer of this bundle (all recipients): two photos turning
    // READY together cannot open two bundles or allocate one sequence twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notification-bundle:${key}`}, 0))`;
    // App clock, read after the lock so activity order follows sequence order.
    const at = new Date();
    for (const { userId: recipientId } of recipients)
      await appendToBundle(tx, {
        kind,
        key,
        recipientId,
        groupId: photo.groupId,
        targetId: photoId,
        actorId,
        eventKey,
        photoId: kind === 'PHOTOS' ? photoId : null,
        at,
      });
    return;
  }
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

async function appendToBundle(
  tx: Prisma.TransactionClient,
  input: {
    kind: BundledKind;
    key: string;
    recipientId: string;
    groupId: string;
    targetId: string;
    actorId: string;
    eventKey: string;
    photoId: string | null;
    at: Date;
  }
) {
  const { kind, key, recipientId, eventKey, at } = input;
  // Lifetime identity per recipient: a photo is announced once and a reactor is
  // counted once per photo, across windows and legacy single-event rows (whose
  // dedupeKey is the event key). Re-reacting after a toggle adds nothing.
  const seen = await tx.$queryRaw<{ id: string }[]>`
    SELECT n.id FROM woori.notifications n
    JOIN woori.notification_activities a ON a."notificationId"=n.id AND a."eventKey"=${eventKey}
    WHERE n."recipientId"=${recipientId}::uuid AND (n."bundleKey"=${key} OR n."dedupeKey"=${eventKey})
    LIMIT 1`;
  if (seen.length) return;
  // Open bundle of this recipient (window fixed at its first activity). Row lock
  // order matches erasure; a row deleted meanwhile is skipped and a new one opens.
  const open = await tx.$queryRaw<{ id: string; bundleUntil: Date }[]>`
    SELECT id,"bundleUntil" FROM woori.notifications
    WHERE "recipientId"=${recipientId}::uuid AND "bundleKey"=${key} AND "bundleUntil">${at}
    ORDER BY "bundleUntil" DESC,id LIMIT 1 FOR NO KEY UPDATE`;
  if (open.length && acceptsActivity(open[0], at)) {
    const notificationId = open[0].id;
    const [{ lastSequence: sequence }] = await tx.$queryRaw<
      { lastSequence: number }[]
    >`UPDATE woori.notifications SET "lastSequence"="lastSequence"+1 WHERE id=${notificationId}::uuid RETURNING "lastSequence"`;
    await tx.notificationActivity.create({
      data: {
        notificationId,
        actorId: input.actorId,
        sequence,
        eventKey,
        photoId: input.photoId,
        createdAt: at,
      },
    });
    // A push of this bundle still waiting to fan out will show the current
    // bundle (display is computed at receipt), so it absorbs this activity. A
    // waiting row locked by a running fanout is skipped: that push may already be
    // on its way, so a follow-up (same tag) is scheduled instead.
    const waiting = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM woori.outbox_events
      WHERE type='NOTIFICATION_PUSH' AND "aggregateId"=${notificationId}::uuid AND status='PENDING'
      LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!waiting.length)
      await tx.outboxEvent.create({
        data: {
          eventKey: `push:${notificationId}:${sequence}`,
          type: 'NOTIFICATION_PUSH',
          aggregateId: notificationId,
          payload: { sequence },
          nextAttemptAt: followUpPushAt(kind, at),
          createdAt: at,
        },
      });
    return;
  }
  const notificationId = randomUUID();
  const { bundleUntil, pushAt } = openBundle(kind, at);
  await tx.notification.create({
    data: {
      id: notificationId,
      recipientId,
      groupId: input.groupId,
      kind,
      // PHOTOS: the bundle's first photo (navigation goes to its album);
      // REACTION: the photo every activity is about.
      targetId: input.targetId,
      dedupeKey: `${key}@${notificationId}`,
      bundleKey: key,
      bundleUntil,
      lastSequence: 1,
      createdAt: at,
    },
  });
  await tx.notificationActivity.create({
    data: {
      notificationId,
      actorId: input.actorId,
      sequence: 1,
      eventKey,
      photoId: input.photoId,
      createdAt: at,
    },
  });
  await tx.outboxEvent.create({
    data: {
      eventKey: `push:${notificationId}:1`,
      type: 'NOTIFICATION_PUSH',
      aggregateId: notificationId,
      payload: { sequence: 1 },
      nextAttemptAt: pushAt,
      createdAt: at,
    },
  });
}
