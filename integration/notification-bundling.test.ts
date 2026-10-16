import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PushTransport } from '../src/common/push/push-transport';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';
import { recordPhotoActivity } from '../src/domain/notifications/notification-events';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import type { MediaVariant } from '../src/common/media/media-storage.service';
import { PushDispatchRepository } from '../src/worker/push/push-dispatch.repository';
import { PushDispatchService } from '../src/worker/push/push-dispatch.service';

// Mutations are permitted only in the disposable database created by the
// existing local integration runner. Never accept the development DB itself.
function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  assert.notEqual(process.env.NODE_ENV, 'production');
  return url.toString();
}
type Agent = ReturnType<typeof request.agent>;
type Account = { agent: Agent; id: string; name: string };
type Item = {
  id: string;
  kind: string;
  groupId: string;
  albumId: string;
  albumTitle: string;
  photoId: string;
  commentId: string | null;
  actor: { id: string; displayName: string };
  count: number;
  createdAt: string;
  latestAt: string;
  latestSequence: number;
  readThroughSequence: number;
  unread: boolean;
  navigation: string;
  mediaKind: string;
  videoCount: number;
};
const MINUTE = 60_000;

test('isolated PostgreSQL: W07 upload/reaction notification bundles', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
    max: 4,
  });
  const app = await createApp();
  const prisma = app.get(PrismaService).client;
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  const password = 'bundle-integration-password-2026';
  const installations: string[] = [];
  let groupId = '';
  try {
    await app.listen(0, '127.0.0.1');
    const fixtureHash = await hashPassword(password);
    // Repository fixtures keep this suite off the shared IP signup quota.
    const session = (agent: Agent, userId: string) => {
      const token = createToken();
      agent.set('Cookie', `woori_session=${token}`);
      return prisma.session.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          audience: 'web',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    };
    const account = async (label: string): Promise<Account> => {
      const agent = request.agent(app.getHttpServer());
      const token = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: `${label}_${suffix}`,
          email: `${label}_${suffix}@example.test`,
          displayName: label,
          passwordHash: fixtureHash,
          verifiedAt: new Date(),
        },
        hashToken(token)
      );
      agent.set('Cookie', `woori_session=${token}`);
      return { agent, id: user.id, name: label };
    };
    const mom = await account('bundle_mom'),
      kid = await account('bundle_kid'),
      dad = await account('bundle_dad'),
      aunt = await account('bundle_aunt'),
      uncle = await account('bundle_uncle');
    // The kid has a second signed-in browser: one delivery per installation.
    const kidPhone = { ...kid, agent: request.agent(app.getHttpServer()) };
    await session(kidPhone.agent, kid.id);
    groupId = (
      await mutate(mom.agent.post('/v1/groups'))
        .send({ name: '묶음 가족' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(mom.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 10 })
        .expect(201)
    ).body;
    for (const member of [kid, dad, aunt, uncle])
      await app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, member.id);
    const album = async (title: string) =>
      (
        await mutate(mom.agent.post(`/v1/groups/${groupId}/albums`))
          .send({ title })
          .expect(201)
      ).body.album.id as string;
    const preferences = async (
      who: Account,
      patch: Record<string, unknown>
    ) => {
      const current = (
        await who.agent.get('/v1/notifications/preferences').expect(200)
      ).body.preferences;
      await mutate(who.agent.patch('/v1/notifications/preferences'))
        .send({ ...patch, version: current.version })
        .expect(200);
    };
    await preferences(kid, { preview: true });
    await preferences(dad, { preview: true });
    const subscribe = async (who: Account) => {
      const ec = createECDH('prime256v1');
      ec.generateKeys();
      const id = (
        await mutate(who.agent.post('/v1/push/subscriptions'))
          .send({
            endpoint: `https://fcm.googleapis.com/fcm/send/bundle-${randomUUID()}`,
            keys: {
              p256dh: ec.getPublicKey().toString('base64url'),
              auth: randomBytes(16).toString('base64url'),
            },
            expirationTime: null,
          })
          .expect(201)
      ).body.installationId as string;
      installations.push(id);
      return id;
    };
    const kidLaptop = await subscribe(kid);
    const kidMobile = await subscribe(kidPhone);
    const dadLaptop = await subscribe(dad);
    // Installations must be bound before a bundle opens (rebinding rule).
    await new Promise((resolve) => setTimeout(resolve, 5));

    const worker = app.get(PushDispatchService);
    const sent: Record<string, string>[] = [];
    app.get(PushTransport).send = async (_subscription, payload) => {
      sent.push(structuredClone(payload) as Record<string, string>);
    };
    const fanout = app.get(PushDispatchRepository);
    // Every due event fans out before any delivery is claimed, so a bundle's
    // waiting delivery is visible to its next event in the same round (also when
    // earlier suites left many due events behind).
    const dispatch = async () => {
      while (await fanout.fanOutOne()) {
        /* drain due outbox events */
      }
      for (let index = 0; index < 3; index++) await worker.runBatch();
    };
    const sentTo = (notificationId: string, installationId?: string) =>
      sent.filter(
        (item) =>
          item.notificationId === notificationId &&
          (!installationId || item.installationId === installationId)
      );
    const readyPhoto = async (uploaderId: string, albumId: string) => {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES ($1,$2,$3,$4,\'READY\',1200,800,1)',
        [id, groupId, albumId, uploaderId]
      );
      return id;
    };
    // The READY transition's notification step in its own domain transaction.
    const publish = (photoId: string, uploaderId: string) =>
      prisma.$transaction((tx) =>
        recordPhotoActivity(tx, photoId, uploaderId, 'PHOTOS', photoId)
      );
    const upload = async (uploaderId: string, albumId: string) => {
      const id = await readyPhoto(uploaderId, albumId);
      await publish(id, uploaderId);
      return id;
    };
    const bundles = async (recipientId: string, key: string) => {
      const rows = (
        await admin.query(
          'SELECT id,"lastSequence","readThroughSequence","createdAt","bundleUntil" FROM woori.notifications WHERE "recipientId"=$1 AND "bundleKey"=$2 ORDER BY "createdAt",id',
          [recipientId, key]
        )
      ).rows as {
        id: string;
        lastSequence: number;
        readThroughSequence: number;
        createdAt: Date;
        bundleUntil: Date;
      }[];
      return rows;
    };
    const activities = async (notificationId: string) =>
      (
        await admin.query(
          'SELECT sequence,"actorId","photoId","createdAt" FROM woori.notification_activities WHERE "notificationId"=$1 ORDER BY sequence',
          [notificationId]
        )
      ).rows as {
        sequence: number;
        actorId: string;
        photoId: string | null;
        createdAt: Date;
      }[];
    const outbox = async (notificationId: string) =>
      (
        await admin.query(
          'SELECT "eventKey",status,"nextAttemptAt","createdAt",payload FROM woori.outbox_events WHERE "aggregateId"=$1 ORDER BY "createdAt","eventKey"',
          [notificationId]
        )
      ).rows as {
        eventKey: string;
        status: string;
        nextAttemptAt: Date;
        createdAt: Date;
        payload: { sequence: number };
      }[];
    const deliveries = async (notificationId: string) =>
      (
        await admin.query(
          'SELECT id,"installationId","deliveryKey",status FROM woori.notification_deliveries WHERE "notificationId"=$1 ORDER BY "deliveryKey"',
          [notificationId]
        )
      ).rows as {
        id: string;
        installationId: string;
        deliveryKey: string;
        status: string;
      }[];
    // Simulates the push delay passing on the dispatcher's (app) clock.
    const pushDue = (ids: string[]) =>
      admin.query(
        'UPDATE woori.outbox_events SET "nextAttemptAt"=$2 WHERE "aggregateId"=ANY($1::uuid[]) AND status=\'PENDING\'',
        [ids, new Date()]
      );
    // Simulates the bundle window passing (bundleUntil is on the app clock).
    const closeWindow = (ids: string[]) =>
      admin.query(
        'UPDATE woori.notifications SET "bundleUntil"=$2 WHERE id=ANY($1::uuid[])',
        [ids, new Date(Date.now() - 1)]
      );
    const inbox = async (who: Account) =>
      (await who.agent.get('/v1/notifications?limit=100').expect(200)).body as {
        notifications: Item[];
        unreadCount: number;
        nextCursor: string | null;
      };
    const item = async (who: Account, id: string) =>
      (await inbox(who)).notifications.find((entry) => entry.id === id);
    const display = async (who: Account, deliveryId: string) =>
      (
        await who.agent
          .get(`/v1/push/deliveries/${deliveryId}/display`)
          .expect(200)
      ).body as { body: string; tag: string; notificationId: string };
    const variants = (photoId: string): MediaVariant[] =>
      (['ORIGINAL', 'DISPLAY', 'THUMBNAIL'] as const).map((kind) => ({
        kind,
        objectKey: `bundle-fixture/${photoId}/${kind.toLowerCase()}`,
        mime: kind === 'ORIGINAL' ? 'image/jpeg' : 'image/webp',
        width: 2,
        height: 2,
        bytes: 1,
      }));

    const album1 = await album('첫 앨범');
    const key1 = `PHOTOS:${album1}:${mom.id}`;
    let kidBundle = '';
    let dadBundle = '';

    await t.test(
      'migration is additive and the runtime role only updates read/sequence columns',
      async () => {
        const columns = (
          await admin.query(
            "SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='woori' AND ((table_name='notifications' AND column_name IN ('bundleKey','bundleUntil','lastSequence')) OR (table_name='notification_activities' AND column_name='photoId')) ORDER BY table_name,column_name"
          )
        ).rows;
        assert.deepEqual(
          columns.map((c) => [c.table_name, c.column_name, c.is_nullable]),
          [
            ['notification_activities', 'photoId', 'YES'],
            ['notifications', 'bundleKey', 'YES'],
            ['notifications', 'bundleUntil', 'YES'],
            ['notifications', 'lastSequence', 'NO'],
          ]
        );
        assert.equal(
          columns.find((c) => c.column_name === 'lastSequence').column_default,
          '1'
        );
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = (
            await runtime.query(
              `SELECT has_table_privilege(current_user,'woori.notifications','UPDATE') AS "tableUpdate",
                has_column_privilege(current_user,'woori.notifications','readThroughSequence','UPDATE') AS "readThrough",
                has_column_privilege(current_user,'woori.notifications','lastSequence','UPDATE') AS "lastSequence",
                has_column_privilege(current_user,'woori.notifications','recipientId','UPDATE') AS "recipient",
                has_column_privilege(current_user,'woori.notifications','targetId','UPDATE') AS "target",
                has_column_privilege(current_user,'woori.notifications','bundleKey','UPDATE') AS "bundleKey",
                has_column_privilege(current_user,'woori.notifications','bundleUntil','UPDATE') AS "bundleUntil",
                has_table_privilege(current_user,'woori.notifications','SELECT') AS "select",
                has_table_privilege(current_user,'woori.notifications','INSERT') AS "insert",
                has_table_privilege(current_user,'woori.notifications','DELETE') AS "delete",
                has_table_privilege(current_user,'woori.notifications','TRUNCATE') AS "truncate",
                has_table_privilege(current_user,'woori.notification_activities','UPDATE') AS "activityUpdate",
                has_column_privilege(current_user,'woori.notification_activities','photoId','UPDATE') AS "activityPhoto"`
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            tableUpdate: false,
            readThrough: true,
            lastSequence: true,
            recipient: false,
            target: false,
            bundleKey: false,
            bundleUntil: false,
            select: true,
            insert: true,
            delete: true,
            truncate: false,
            activityUpdate: false,
            activityPhoto: false,
          });
          for (const statement of [
            'UPDATE woori.notifications SET "bundleUntil"=NULL WHERE false',
            'UPDATE woori.notifications SET "targetId"="targetId" WHERE false',
            'UPDATE woori.notification_activities SET sequence=sequence WHERE false',
          ])
            await assert.rejects(
              runtime.query(statement),
              (error: { code?: string }) => error.code === '42501'
            );
          await runtime.query(
            'UPDATE woori.notifications SET "lastSequence"="lastSequence","readThroughSequence"="readThroughSequence" WHERE false'
          );
        } finally {
          await runtime.end();
        }
      }
    );

    await t.test(
      'a burst of READY uploads is one row per recipient and one delayed push per installation',
      async () => {
        const repository = app.get(PhotosRepository);
        const photos: { id: string; token: string }[] = [];
        for (let index = 0; index < 5; index++) {
          const photo = { id: randomUUID(), token: randomUUID() };
          await admin.query(
            'INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,"processingToken","processingUntil","reservedBytes",bytes) VALUES ($1,$2,$3,$4,\'PROCESSING\',$5,$6,10,0)',
            [
              photo.id,
              groupId,
              album1,
              mom.id,
              photo.token,
              new Date(Date.now() + 5 * MINUTE),
            ]
          );
          photos.push(photo);
        }
        // The real READY path (photo finish) for all five at once.
        await Promise.all(
          photos.map((photo) =>
            repository.finish(
              groupId,
              album1,
              photo.id,
              mom.id,
              photo.token,
              variants(photo.id)
            )
          )
        );
        assert.deepEqual(await bundles(mom.id, key1), []);
        for (const recipient of [kid, dad, aunt, uncle]) {
          const rows = await bundles(recipient.id, key1);
          assert.equal(rows.length, 1, recipient.name);
          assert.equal(rows[0].lastSequence, 5);
          const acts = await activities(rows[0].id);
          assert.deepEqual(
            acts.map((a) => a.sequence),
            [1, 2, 3, 4, 5]
          );
          assert.deepEqual(
            acts.map((a) => a.photoId).sort(),
            photos.map((p) => p.id).sort()
          );
          assert.ok(acts.every((a) => a.actorId === mom.id));
          // The window is fixed at the first photo; the push waits 2 minutes.
          assert.equal(
            rows[0].bundleUntil.getTime() - rows[0].createdAt.getTime(),
            10 * MINUTE
          );
          const events = await outbox(rows[0].id);
          assert.equal(events.length, 1);
          assert.equal(
            events[0].nextAttemptAt.getTime() - events[0].createdAt.getTime(),
            2 * MINUTE
          );
          assert.equal(
            events[0].createdAt.getTime(),
            acts[0].createdAt.getTime()
          );
        }
        kidBundle = (await bundles(kid.id, key1))[0].id;
        dadBundle = (await bundles(dad.id, key1))[0].id;
        const latestPhoto = (await activities(kidBundle)).at(-1)!.photoId;
        const entry = await item(kid, kidBundle);
        assert.ok(entry);
        // NotificationItem (0.20.0 bundle fields, 0.22.0 media fields; internal
        // columns stay server-side).
        assert.deepEqual(Object.keys(entry).sort(), [
          'actor',
          'albumId',
          'albumTitle',
          'commentId',
          'count',
          'createdAt',
          'groupId',
          'groupName',
          'id',
          'kind',
          'latestAt',
          'latestSequence',
          'mediaKind',
          'navigation',
          'photoId',
          'readThroughSequence',
          'unread',
          'videoCount',
        ]);
        assert.equal(entry.mediaKind, 'PHOTO');
        assert.equal(entry.videoCount, 0);
        assert.equal(entry.kind, 'PHOTOS');
        assert.equal(entry.count, 5);
        assert.equal(entry.navigation, 'ALBUM');
        assert.equal(entry.groupId, groupId);
        assert.equal(entry.albumId, album1);
        assert.equal(entry.albumTitle, '첫 앨범');
        assert.equal(entry.photoId, latestPhoto);
        assert.equal(entry.commentId, null);
        assert.deepEqual(entry.actor, { id: mom.id, displayName: mom.name });
        assert.equal(entry.latestSequence, 5);
        assert.equal(entry.readThroughSequence, 0);
        assert.equal(entry.unread, true);
        assert.ok(Date.parse(entry.latestAt) >= Date.parse(entry.createdAt));
        assert.equal(
          (await inbox(mom)).notifications.some((n) => n.id === kidBundle),
          false
        );
        const target = (
          await kid.agent
            .get(`/v1/notifications/${kidBundle}/target`)
            .expect(200)
        ).body;
        assert.deepEqual(target, {
          groupId,
          albumId: album1,
          photoId: latestPhoto,
          commentId: null,
          latestSequence: 5,
          mediaKind: 'PHOTO',
          navigation: 'ALBUM',
          uploader: { id: mom.id, displayName: mom.name },
        });
        // Not due yet: nothing is fanned out or sent before the delay.
        await dispatch();
        assert.deepEqual(await deliveries(kidBundle), []);
        assert.equal(sentTo(kidBundle).length, 0);
        await pushDue([kidBundle, dadBundle]);
        await dispatch();
        const kidDeliveries = await deliveries(kidBundle);
        assert.deepEqual(
          kidDeliveries.map((d) => d.installationId).sort(),
          [kidLaptop, kidMobile].sort()
        );
        assert.equal(sentTo(kidBundle, kidLaptop).length, 1);
        assert.equal(sentTo(kidBundle, kidMobile).length, 1);
        assert.equal(sentTo(dadBundle, dadLaptop).length, 1);
        for (const payload of sentTo(kidBundle))
          assert.deepEqual(Object.keys(payload).sort(), [
            'deliveryId',
            'installationId',
            'notificationId',
            'recipientId',
          ]);
        // Display is bound to the installation's own session (laptop here).
        const laptopDelivery = kidDeliveries.find(
          (d) => d.installationId === kidLaptop
        )!;
        await kidPhone.agent
          .get(`/v1/push/deliveries/${laptopDelivery.id}/display`)
          .expect(404);
        const shown = await display(kid, laptopDelivery.id);
        assert.equal(
          shown.body,
          `${mom.name}님이 '첫 앨범'에 사진 5장을 올렸어요.`
        );
        assert.equal(shown.tag, `woori-${kidBundle}`);
        assert.doesNotMatch(
          JSON.stringify(shown),
          /bundle-fixture|https?:\/\/(?!localhost)/
        );
        await dispatch();
        assert.equal(sentTo(kidBundle).length, 2, 'Sent once per installation');
      }
    );

    await t.test(
      'later photos join the same row and replace the sent push once; a new window opens a new bundle',
      async () => {
        const sixth = await upload(mom.id, album1);
        const seventh = await upload(mom.id, album1);
        const [row] = await bundles(kid.id, key1);
        assert.equal(row.id, kidBundle);
        assert.equal(row.lastSequence, 7);
        // The first push already went out: exactly one follow-up event (queued by
        // the 6th photo, which the 7th joined), 2 minutes after the 6th photo.
        const events = await outbox(kidBundle);
        assert.equal(events.length, 2);
        const followUp = events.find((e) => e.status === 'PENDING')!;
        assert.equal(followUp.eventKey, `push:${kidBundle}:6`);
        const sixthActivity = (await activities(kidBundle)).find(
          (a) => a.photoId === sixth
        )!;
        assert.equal(
          followUp.nextAttemptAt.getTime() - sixthActivity.createdAt.getTime(),
          2 * MINUTE
        );
        assert.ok(
          (await activities(kidBundle)).some((a) => a.photoId === seventh)
        );
        await pushDue([kidBundle, dadBundle]);
        await dispatch();
        assert.equal(sentTo(kidBundle, kidLaptop).length, 2);
        assert.equal(sentTo(kidBundle, kidMobile).length, 2);
        const keys = (await deliveries(kidBundle)).map((d) => d.deliveryKey);
        assert.equal(keys.length, 4);
        assert.equal(new Set(keys).size, 4);
        const latest = sentTo(kidBundle, kidLaptop).at(-1)!;
        const replaced = await display(kid, latest.deliveryId);
        assert.equal(replaced.tag, `woori-${kidBundle}`);
        assert.equal(
          replaced.body,
          `${mom.name}님이 '첫 앨범'에 사진 7장을 올렸어요.`
        );
        assert.equal((await item(kid, kidBundle))?.count, 7);

        // A fanout holding the waiting event: the new photo cannot rely on it,
        // so it queues its own follow-up instead of being lost.
        await upload(mom.id, album1);
        const holder = await admin.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM woori.outbox_events WHERE "aggregateId"=$1 AND status=\'PENDING\' FOR UPDATE',
            [kidBundle]
          );
          await upload(mom.id, album1);
          await holder.query('ROLLBACK');
        } finally {
          holder.release();
        }
        assert.deepEqual(
          (await outbox(kidBundle))
            .filter((e) => e.status === 'PENDING')
            .map((e) => e.eventKey)
            .sort(),
          [`push:${kidBundle}:8`, `push:${kidBundle}:9`]
        );
        await pushDue([kidBundle, dadBundle]);
        await dispatch();
        // Both events fan out, but each installation gets at most one waiting
        // delivery per bundle, so this round adds one push per installation.
        assert.equal(sentTo(kidBundle, kidLaptop).length, 3);
        assert.equal(sentTo(kidBundle, kidMobile).length, 3);

        // 10 minutes after the FIRST photo the window is closed (simulated).
        await closeWindow(
          [
            ...(await bundles(kid.id, key1)),
            ...(await bundles(dad.id, key1)),
          ].map((r) => r.id)
        );
        const next = await upload(mom.id, album1);
        const kidRows = await bundles(kid.id, key1);
        assert.equal(kidRows.length, 2);
        assert.equal(kidRows[0].id, kidBundle);
        assert.equal(kidRows[0].lastSequence, 9);
        assert.equal(kidRows[1].lastSequence, 1);
        assert.deepEqual(
          (await activities(kidRows[1].id)).map((a) => a.photoId),
          [next]
        );
        assert.equal((await item(kid, kidRows[1].id))?.count, 1);
        assert.equal((await item(kid, kidBundle))?.count, 9);
        assert.equal((await outbox(kidRows[1].id)).length, 1);
        // Another album or another uploader is a separate bundle.
        const album2 = await album('둘째 앨범');
        await upload(mom.id, album2);
        await upload(dad.id, album1);
        assert.equal(
          (await bundles(kid.id, `PHOTOS:${album2}:${mom.id}`)).length,
          1
        );
        assert.equal(
          (await bundles(kid.id, `PHOTOS:${album1}:${dad.id}`)).length,
          1
        );
        assert.equal(
          (await bundles(mom.id, `PHOTOS:${album1}:${dad.id}`)).length,
          1
        );
        assert.equal(
          (await bundles(dad.id, `PHOTOS:${album1}:${dad.id}`)).length,
          0
        );
      }
    );

    const album3 = await album('셋째 앨범');
    const key3 = `PHOTOS:${album3}:${mom.id}`;
    const album3Photos: string[] = [];
    await t.test(
      'concurrent READY events cannot open two bundles or reuse a sequence',
      async () => {
        for (let index = 0; index < 8; index++)
          album3Photos.push(await readyPhoto(mom.id, album3));
        // No outer group lock here: only the bundle lock serializes them.
        await Promise.all(album3Photos.map((id) => publish(id, mom.id)));
        for (const recipient of [kid, dad, aunt, uncle]) {
          const rows = await bundles(recipient.id, key3);
          assert.equal(rows.length, 1, recipient.name);
          assert.equal(rows[0].lastSequence, 8);
          const acts = await activities(rows[0].id);
          assert.deepEqual(
            acts.map((a) => a.sequence),
            [1, 2, 3, 4, 5, 6, 7, 8]
          );
          assert.equal(new Set(acts.map((a) => a.photoId)).size, 8);
          assert.equal((await outbox(rows[0].id)).length, 1);
        }
        // Replaying a READY event adds nothing.
        await publish(album3Photos[0], mom.id);
        assert.equal((await bundles(kid.id, key3))[0].lastSequence, 8);
      }
    );

    await t.test(
      'reads follow the observed sequence and new activity makes a read bundle unread',
      async () => {
        const [bundle] = await bundles(kid.id, key3);
        const before = (await inbox(kid)).unreadCount;
        const invalid = await mutate(
          kid.agent.patch(`/v1/notifications/${bundle.id}/read`)
        )
          .send({ throughSequence: 9 })
          .expect(400);
        assert.equal(invalid.body.code, 'NOTIFICATION_SEQUENCE_INVALID');
        await mutate(dad.agent.patch(`/v1/notifications/${bundle.id}/read`))
          .send({ throughSequence: 1 })
          .expect(404);
        const read = (
          await mutate(kid.agent.patch(`/v1/notifications/${bundle.id}/read`))
            .send({ throughSequence: 8 })
            .expect(200)
        ).body;
        assert.deepEqual(read, { id: bundle.id, readThroughSequence: 8 });
        assert.equal((await item(kid, bundle.id))?.unread, false);
        assert.equal((await inbox(kid)).unreadCount, before - 1);
        const ninth = await upload(mom.id, album3);
        album3Photos.push(ninth);
        let entry = (await item(kid, bundle.id))!;
        assert.equal(entry.latestSequence, 9);
        assert.equal(entry.count, 9);
        assert.equal(entry.unread, true);
        assert.equal((await inbox(kid)).unreadCount, before);
        // The bundle moves to the top: newest activity first.
        assert.equal((await inbox(kid)).notifications[0].id, bundle.id);
        // A stale observation (read before the 9th photo) keeps it unread.
        await mutate(kid.agent.post('/v1/notifications/read-all'))
          .send({ notifications: [{ id: bundle.id, throughSequence: 8 }] })
          .expect(200);
        assert.equal((await item(kid, bundle.id))?.unread, true);
        await mutate(kid.agent.patch(`/v1/notifications/${bundle.id}/read`))
          .send({ throughSequence: 3 })
          .expect(200);
        assert.equal((await bundles(kid.id, key3))[0].readThroughSequence, 8);
        const all = await mutate(kid.agent.post('/v1/notifications/read-all'))
          .send({ notifications: [{ id: bundle.id, throughSequence: 9 }] })
          .expect(200);
        assert.equal(all.body.updated, 1);
        entry = (await item(kid, bundle.id))!;
        assert.equal(entry.unread, false);
        assert.equal(entry.readThroughSequence, 9);
        // Cursor pages keep the latestAt order without gaps or repeats.
        const full = (await inbox(kid)).notifications.map((n) => n.id);
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const page: { notifications: Item[]; nextCursor: string | null } = (
            await kid.agent
              .get('/v1/notifications')
              .query({ limit: 2, ...(cursor ? { cursor } : {}) })
              .expect(200)
          ).body;
          paged.push(...page.notifications.map((n) => n.id));
          cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(paged, full);
      }
    );

    await t.test(
      'deleted or hidden photos leave the count and an empty bundle disappears',
      async () => {
        const [bundle] = await bundles(kid.id, key3);
        const ninth = album3Photos[8];
        await admin.query(
          'UPDATE woori.photos SET "deletedAt"=now() WHERE id=$1',
          [ninth]
        );
        let entry = (await item(kid, bundle.id))!;
        assert.equal(entry.count, 8);
        assert.equal(entry.latestSequence, 8);
        assert.notEqual(entry.photoId, ninth);
        assert.equal(entry.unread, false);
        // Every photo deleted: no stale item, target, read or push display.
        await admin.query(
          'UPDATE woori.photos SET "deletedAt"=now() WHERE id=ANY($1::uuid[])',
          [album3Photos]
        );
        assert.equal(await item(kid, bundle.id), undefined);
        await kid.agent
          .get(`/v1/notifications/${bundle.id}/target`)
          .expect(404);
        await mutate(kid.agent.patch(`/v1/notifications/${bundle.id}/read`))
          .send({ throughSequence: 1 })
          .expect(404);
        await admin.query(
          'UPDATE woori.photos SET "deletedAt"=NULL WHERE id=$1',
          [album3Photos[2]]
        );
        const restored = (await activities(bundle.id)).find(
          (a) => a.photoId === album3Photos[2]
        )!;
        entry = (await item(kid, bundle.id))!;
        assert.equal(entry.count, 1);
        assert.equal(entry.latestSequence, restored.sequence);
        assert.equal(entry.photoId, album3Photos[2]);
      }
    );

    const kidPhoto = await readyPhoto(kid.id, album1);
    const reactionKey = `REACTION:${kidPhoto}`;
    let firstReaction = '';
    let secondReaction = '';
    const react = (who: Account, emoji: string) =>
      mutate(who.agent.put(`/v1/photos/${kidPhoto}/reactions`))
        .send({ emoji })
        .expect(200);
    await t.test(
      'reactions bundle per photo for 30 minutes with one identity per reactor',
      async () => {
        await react(mom, '❤️');
        await react(dad, '😂');
        await react(aunt, '👏');
        const rows = await bundles(kid.id, reactionKey);
        assert.equal(rows.length, 1);
        firstReaction = rows[0].id;
        assert.equal(rows[0].lastSequence, 3);
        assert.equal(
          rows[0].bundleUntil.getTime() - rows[0].createdAt.getTime(),
          30 * MINUTE
        );
        const events = await outbox(firstReaction);
        assert.equal(events.length, 1);
        assert.equal(
          events[0].nextAttemptAt.getTime() - events[0].createdAt.getTime(),
          MINUTE
        );
        // Only the photo's uploader is notified.
        for (const other of [mom, dad, aunt, uncle])
          assert.deepEqual(await bundles(other.id, reactionKey), []);
        let entry = (await item(kid, firstReaction))!;
        assert.equal(entry.kind, 'REACTION');
        assert.equal(entry.count, 3);
        assert.equal(entry.navigation, 'PHOTO');
        assert.equal(entry.photoId, kidPhoto);
        assert.deepEqual(entry.actor, { id: aunt.id, displayName: aunt.name });
        assert.equal(
          (
            await kid.agent
              .get(`/v1/notifications/${firstReaction}/target`)
              .expect(200)
          ).body.navigation,
          'PHOTO'
        );
        await pushDue([firstReaction]);
        await dispatch();
        assert.equal(sentTo(firstReaction, kidLaptop).length, 1);
        assert.equal(sentTo(firstReaction, kidMobile).length, 1);
        const shown = await display(
          kid,
          sentTo(firstReaction, kidLaptop)[0].deliveryId
        );
        assert.equal(
          shown.body,
          `${aunt.name}님 외 2명이 내 사진에 반응했어요.`
        );
        assert.equal(shown.tag, `woori-${firstReaction}`);
        // A removed reaction leaves the count; reacting again restores it
        // without a new activity or push (one lifetime identity per reactor).
        await mutate(
          dad.agent.delete(`/v1/photos/${kidPhoto}/reactions`)
        ).expect(200);
        assert.equal((await item(kid, firstReaction))?.count, 2);
        await react(dad, '🥰');
        entry = (await item(kid, firstReaction))!;
        assert.equal(entry.count, 3);
        assert.equal(entry.latestSequence, 3);
        assert.equal((await bundles(kid.id, reactionKey))[0].lastSequence, 3);
        assert.equal((await outbox(firstReaction)).length, 1);
        // After 30 minutes (simulated) a new reactor opens a new bundle; earlier
        // reactors toggling again still add nothing anywhere.
        await closeWindow([firstReaction]);
        await react(uncle, '😮');
        await react(mom, '😂');
        const after = await bundles(kid.id, reactionKey);
        assert.equal(after.length, 2);
        secondReaction = after[1].id;
        assert.deepEqual(
          (await activities(secondReaction)).map((a) => a.actorId),
          [uncle.id]
        );
        assert.equal(after[0].lastSequence, 3);
        assert.equal((await item(kid, secondReaction))?.count, 1);
      }
    );

    await t.test(
      'quiet hours release one push per bundle, not one per photo',
      async () => {
        const now = new Date();
        const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
        await preferences(dad, {
          quietEnabled: true,
          quietStartMinute: (minute + 1438) % 1440,
          quietEndMinute: (minute + 30) % 1440,
          timeZone: 'UTC',
        });
        const albumA = await album('방해 금지 A');
        const albumB = await album('방해 금지 B');
        for (let index = 0; index < 3; index++) await upload(mom.id, albumA);
        for (let index = 0; index < 2; index++) await upload(mom.id, albumB);
        const [a] = await bundles(dad.id, `PHOTOS:${albumA}:${mom.id}`);
        const [b] = await bundles(dad.id, `PHOTOS:${albumB}:${mom.id}`);
        await pushDue([a.id, b.id]);
        await dispatch();
        assert.equal(sentTo(a.id).length + sentTo(b.id).length, 0);
        for (const id of [a.id, b.id]) {
          const rows = await deliveries(id);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].status, 'PENDING');
        }
        // Two more photos while held: the bundle's follow-up event fans out but
        // joins the held delivery instead of queuing a second one.
        await upload(mom.id, albumA);
        await upload(mom.id, albumA);
        assert.equal(
          (await outbox(a.id)).filter((e) => e.status === 'PENDING').length,
          1
        );
        await pushDue([a.id]);
        await dispatch();
        assert.equal((await deliveries(a.id)).length, 1);
        assert.equal(sentTo(a.id).length, 0);
        await preferences(dad, { quietEnabled: false });
        await admin.query(
          'UPDATE woori.notification_deliveries SET "nextAttemptAt"=$2 WHERE "notificationId"=ANY($1::uuid[])',
          [[a.id, b.id], new Date()]
        );
        await dispatch();
        assert.equal(sentTo(a.id, dadLaptop).length, 1);
        assert.equal(sentTo(b.id, dadLaptop).length, 1);
        const released = await display(
          dad,
          sentTo(a.id, dadLaptop)[0].deliveryId
        );
        assert.equal(
          released.body,
          `${mom.name}님이 '방해 금지 A'에 사진 5장을 올렸어요.`
        );
        await dispatch();
        assert.equal(sentTo(a.id).length + sentTo(b.id).length, 2);
      }
    );

    await t.test(
      'concurrent fanouts of one bundle leave one waiting delivery per installation',
      async () => {
        const index = (
          await admin.query(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='woori' AND indexname='notification_deliveries_one_waiting_idx'"
          )
        ).rows[0]?.indexdef as string;
        assert.match(index, /CREATE UNIQUE INDEX/);
        assert.match(index, /"notificationId", "installationId"/);
        assert.match(index, /WHERE \(status = ANY/);
        await dispatch();
        const albumC = await album('동시 발송');
        await upload(mom.id, albumC);
        const [bundle] = await bundles(kid.id, `PHOTOS:${albumC}:${mom.id}`);
        // A second waiting event of the same bundle (as when a follow-up was
        // queued while the first event was being fanned out by a replica).
        await admin.query(
          'INSERT INTO woori.outbox_events (id,"eventKey",type,"aggregateId",payload,"nextAttemptAt") VALUES ($1,$2,\'NOTIFICATION_PUSH\',$3,$4,$5)',
          [
            randomUUID(),
            `push:${bundle.id}:99`,
            bundle.id,
            JSON.stringify({ sequence: 99 }),
            new Date(),
          ]
        );
        await pushDue([bundle.id]);
        // Both fanouts read "no waiting delivery" before either commits: the
        // installation rows are held so each stops at its insert.
        const holder = await admin.connect();
        let both: Promise<boolean[]> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM woori.push_installations WHERE id=ANY($1::uuid[]) FOR UPDATE',
            [[kidLaptop, kidMobile]]
          );
          both = Promise.all([fanout.fanOutOne(), fanout.fanOutOne()]);
          let waiting = 0;
          for (let attempt = 0; attempt < 250 && waiting < 2; attempt++) {
            waiting = (
              await admin.query(
                'SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()'
              )
            ).rows[0].n;
            if (waiting < 2)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(waiting, 2, 'Both fanouts must be in flight together');
          await holder.query('ROLLBACK');
        } finally {
          holder.release();
        }
        assert.deepEqual(await both, [true, true]);
        const rows = await deliveries(bundle.id);
        for (const installation of [kidLaptop, kidMobile])
          assert.equal(
            rows.filter(
              (row) =>
                row.installationId === installation &&
                ['PENDING', 'RUNNING'].includes(row.status)
            ).length,
            1,
            installation
          );
        assert.deepEqual(
          (await outbox(bundle.id)).map((event) => event.status),
          ['DONE', 'DONE']
        );
        await dispatch();
        assert.equal(sentTo(bundle.id, kidLaptop).length, 1);
        assert.equal(sentTo(bundle.id, kidMobile).length, 1);
      }
    );

    let erased: string[] = [];
    await t.test(
      'blocking erases every bundle holding the blocked user’s activity; unblocking restores none',
      async () => {
        erased = (
          await admin.query(
            'SELECT DISTINCT n.id FROM woori.notifications n JOIN woori.notification_activities a ON a."notificationId"=n.id WHERE n."recipientId"=$1 AND a."actorId"=$2 ORDER BY n.id',
            [kid.id, mom.id]
          )
        ).rows.map((row) => row.id);
        assert.ok(erased.includes(kidBundle));
        assert.ok(erased.includes(firstReaction));
        assert.ok(!erased.includes(secondReaction));
        await mutate(kid.agent.put(`/v1/blocks/${mom.id}`)).expect(200);
        for (const [table, column] of [
          ['notifications', 'id'],
          ['notification_activities', 'notificationId'],
          ['notification_deliveries', 'notificationId'],
          ['outbox_events', 'aggregateId'],
        ])
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int AS n FROM woori.${table} WHERE "${column}"=ANY($1::uuid[])`,
                [erased]
              )
            ).rows[0].n,
            0,
            table
          );
        // The mixed reaction bundle went as a whole; the uncle-only one stays.
        assert.ok(await item(kid, secondReaction));
        // Other recipients keep theirs.
        assert.equal((await bundles(dad.id, key1)).length, 2);
        const whileBlocked = await upload(mom.id, album1);
        assert.deepEqual(await bundles(kid.id, key1), []);
        // Dad still gets it (his current album1 bundle gains the photo).
        const dadOpen = (await bundles(dad.id, key1)).at(-1)!;
        assert.ok(
          (await activities(dadOpen.id)).some((a) => a.photoId === whileBlocked)
        );
        await mutate(kid.agent.delete(`/v1/blocks/${mom.id}`)).expect(204);
        const visibleIds = (await inbox(kid)).notifications.map((n) => n.id);
        assert.ok(erased.every((id) => !visibleIds.includes(id)));
        assert.deepEqual(await bundles(kid.id, key1), []);
        const afterUnblock = await upload(mom.id, album1);
        const fresh = await bundles(kid.id, key1);
        assert.equal(fresh.length, 1);
        assert.deepEqual(
          (await activities(fresh[0].id)).map((a) => a.photoId),
          [afterUnblock]
        );
        assert.notEqual(afterUnblock, whileBlocked);
      }
    );

    await t.test(
      'erasure waits for an in-flight bundle append and removes it with the row',
      async () => {
        const holder = await admin.connect();
        let blocking: Promise<{ status: number }> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM woori.notifications WHERE id=$1 FOR NO KEY UPDATE',
            [secondReaction]
          );
          const xid = (
            await holder.query('SELECT pg_current_xact_id()::xid::text AS xid')
          ).rows[0].xid as string;
          blocking = mutate(kid.agent.put(`/v1/blocks/${uncle.id}`)).then(
            (response) => response
          );
          // Wait until the block's erasure is queued behind this appender.
          let queued = false;
          for (let attempt = 0; attempt < 250 && !queued; attempt++) {
            queued =
              (
                await admin.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='transactionid' AND NOT granted AND transactionid::text=$1",
                  [xid]
                )
              ).rows[0].n > 0;
            if (!queued)
              await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(queued, 'Erasure must wait for the in-flight append');
          // The appender adds another reactor's activity and commits.
          await holder.query(
            'UPDATE woori.notifications SET "lastSequence"="lastSequence"+1 WHERE id=$1',
            [secondReaction]
          );
          await holder.query(
            'INSERT INTO woori.notification_activities (id,"notificationId","actorId",sequence,"eventKey") VALUES ($1,$2,$3,2,$4)',
            [randomUUID(), secondReaction, aunt.id, `fixture:${randomUUID()}`]
          );
          await holder.query('COMMIT');
        } finally {
          holder.release();
        }
        assert.equal((await blocking!).status, 200);
        for (const table of ['notifications', 'notification_activities'])
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int AS n FROM woori.${table} WHERE "${table === 'notifications' ? 'id' : 'notificationId'}"=$1`,
                [secondReaction]
              )
            ).rows[0].n,
            0,
            table
          );
        await mutate(kid.agent.delete(`/v1/blocks/${uncle.id}`)).expect(204);
      }
    );

    await t.test(
      'a waiting delivery of an older binding is superseded so the current binding still gets the bundle',
      async () => {
        await dispatch();
        const albumR = await album('재바인딩');
        await upload(mom.id, albumR);
        const [bundle] = await bundles(kid.id, `PHOTOS:${albumR}:${mom.id}`);
        await pushDue([bundle.id]);
        // Fan out only: the deliveries stay waiting (as in quiet hours).
        while (await fanout.fanOutOne()) {
          /* drain */
        }
        const waitingRows = async () =>
          (
            await admin.query(
              'SELECT id,"installationId","bindingVersion","deliveryKey",status,"resultCode","leaseToken" FROM woori.notification_deliveries WHERE "notificationId"=$1 ORDER BY "deliveryKey"',
              [bundle.id]
            )
          ).rows as {
            id: string;
            installationId: string;
            bindingVersion: number;
            deliveryKey: string;
            status: string;
            resultCode: string | null;
            leaseToken: string | null;
          }[];
        const first = await waitingRows();
        const old = first.find((row) => row.installationId === kidLaptop)!;
        const mobile = first.find((row) => row.installationId === kidMobile)!;
        assert.equal(old.status, 'PENDING');
        // The laptop is re-bound while its bound time stays before the bundle
        // (as with API replicas whose clocks differ): the waiting row now
        // belongs to a binding that can never be sent.
        const rebound = (
          await admin.query(
            'UPDATE woori.push_installations SET "bindingVersion"="bindingVersion"+1 WHERE id=$1 RETURNING "bindingVersion"',
            [kidLaptop]
          )
        ).rows[0].bindingVersion as number;
        assert.notEqual(rebound, old.bindingVersion);
        // The next activity of the bundle fans out again.
        await upload(mom.id, albumR);
        await pushDue([bundle.id]);
        while (await fanout.fanOutOne()) {
          /* drain */
        }
        const rows = await waitingRows();
        const closed = rows.find((row) => row.id === old.id)!;
        assert.equal(closed.status, 'DONE');
        assert.equal(closed.resultCode, 'superseded');
        assert.equal(closed.leaseToken, null);
        const laptopWaiting = rows.filter(
          (row) =>
            row.installationId === kidLaptop &&
            ['PENDING', 'RUNNING'].includes(row.status)
        );
        assert.equal(laptopWaiting.length, 1);
        assert.equal(laptopWaiting[0].bindingVersion, rebound);
        assert.match(laptopWaiting[0].deliveryKey, new RegExp(`:${rebound}$`));
        // The unchanged binding keeps its one waiting row (no duplicate).
        assert.deepEqual(
          rows
            .filter(
              (row) =>
                row.installationId === kidMobile &&
                ['PENDING', 'RUNNING'].includes(row.status)
            )
            .map((row) => row.id),
          [mobile.id]
        );
        await dispatch();
        assert.equal(sentTo(bundle.id, kidLaptop).length, 1);
        assert.equal(sentTo(bundle.id, kidMobile).length, 1);
      }
    );

    await t.test(
      'account deletion and group deletion keep working with multi-activity bundles',
      async () => {
        const dadRows = (
          await admin.query(
            'SELECT n.id FROM woori.notifications n WHERE n."recipientId"=$1 AND n."lastSequence">1',
            [dad.id]
          )
        ).rows;
        assert.ok(dadRows.length >= 2);
        // The kid's bundle of dad's upload disappears with dad's account.
        const dadUploads = await bundles(kid.id, `PHOTOS:${album1}:${dad.id}`);
        assert.ok(await item(kid, dadUploads[0].id));
        await mutate(dad.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        for (const [table, where] of [
          ['notifications', '"recipientId"=$1'],
          [
            'notification_activities',
            '"notificationId" IN (SELECT id FROM woori.notifications WHERE "recipientId"=$1)',
          ],
          [
            'notification_deliveries',
            '"installationId" IN (SELECT id FROM woori.push_installations WHERE "userId"=$1)',
          ],
        ])
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int AS n FROM woori.${table} WHERE ${where}`,
                [dad.id]
              )
            ).rows[0].n,
            0,
            table
          );
        assert.equal(await item(kid, dadUploads[0].id), undefined);
        const before = (await inbox(kid)).notifications.filter(
          (n) => n.groupId === groupId
        );
        assert.ok(before.length > 0);
        await mutate(mom.agent.delete(`/v1/groups/${groupId}`))
          .send({ name: '묶음 가족' })
          .expect(202);
        assert.equal(
          (await inbox(kid)).notifications.some((n) => n.groupId === groupId),
          false
        );
        await kid.agent
          .get(`/v1/notifications/${before[0].id}/target`)
          .expect(404);
      }
    );
  } finally {
    // The runner shares one isolated DB across suites: retire this suite's push
    // fixtures so a later push worker test never sends these notifications.
    if (installations.length)
      await admin.query(
        'UPDATE woori.push_installations SET enabled=false,"revokedAt"=now() WHERE id=ANY($1::uuid[])',
        [installations]
      );
    await admin.query(
      'UPDATE woori.notification_deliveries SET status=\'DONE\',"resultCode"=\'fixture-cleanup\',"leaseToken"=NULL,"leaseUntil"=NULL WHERE "installationId"=ANY($1::uuid[]) AND status IN (\'PENDING\',\'RUNNING\')',
      [installations]
    );
    if (groupId)
      await admin.query(
        'UPDATE woori.outbox_events SET status=\'DONE\' WHERE "aggregateId" IN (SELECT id FROM woori.notifications WHERE "groupId"=$1) AND status=\'PENDING\'',
        [groupId]
      );
    await app.close();
    await admin.end();
  }
});
