import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PushTransport } from '../src/common/push/push-transport';
import { PushDispatchService } from '../src/worker/push/push-dispatch.service';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { recordPhotoActivity } from '../src/domain/notifications/notification-events';
import { PushDispatchRepository } from '../src/worker/push/push-dispatch.repository';

// Mutations are permitted only in the disposable database created by the
// existing local integration runner. Never accept the development DB itself.
function isolatedDatabase(key: string): string {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  const value = process.env[key];
  assert.ok(value);
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  assert.notEqual(process.env.NODE_ENV, 'production');
  return value;
}

function subscription(label: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/woori-test-${label}-${randomUUID()}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
    expirationTime: null,
  };
}

test('isolated PostgreSQL: Web Push account, subscription and dispatch boundaries', async (t) => {
  isolatedDatabase('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolatedDatabase('MIGRATION_DATABASE_URL'),
    max: 2,
  });
  assert.equal(process.env.MAIL_MODE, 'file');
  const app = await createApp();
  const origin = process.env.WEB_ORIGIN;
  assert.ok(origin);
  const mutate = (operation: Test) =>
    operation.set('Origin', origin).set('X-Woori-Request', '1');
  const suffix = randomBytes(5).toString('hex');
  type Account = {
    agent: ReturnType<typeof request.agent>;
    id: string;
    username: string;
  };
  const password = 'push-integration-only-password-2026';
  try {
    await app.listen(0, '127.0.0.1');
    const anonymous = request(app.getHttpServer());
    const signup = async (name: string): Promise<Account> => {
      const agent = request.agent(app.getHttpServer());
      const username = `${name}_${suffix}`;
      const response = await mutate(agent.post('/v1/auth/signup'))
        .send({
          username,
          email: `${username}@example.test`,
          displayName: name,
          password,
        })
        .expect(201);
      // Verification mail stays local. This fixture setup bypasses only the
      // email round trip, while every push operation uses the real session.
      await admin.query(
        'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
        [response.body.user.id]
      );
      return { agent, username, id: response.body.user.id };
    };
    const owner = await signup('push_owner');
    const member = await signup('push_member');
    const worker = app.get(PushDispatchService);
    const transport = app.get(PushTransport);
    const sent: { endpoint: string; payload: Record<string, string> }[] = [];
    let sendError: number | undefined;
    transport.send = async (data, payload) => {
      if (sendError)
        throw Object.assign(new Error('simulated-provider-error'), {
          statusCode: sendError,
        });
      sent.push({
        endpoint: data.endpoint,
        payload: structuredClone(payload) as Record<string, string>,
      });
    };
    const register = async (
      account: Account,
      data: ReturnType<typeof subscription>
    ) =>
      (
        await mutate(account.agent.post('/v1/push/subscriptions'))
          .send(data)
          .expect(201)
      ).body as { installationId: string; enabled: boolean };
    const status = async (account: Account, endpoint: string) =>
      (
        await mutate(account.agent.post('/v1/push/subscriptions/status'))
          .send({ endpoint })
          .expect(200)
      ).body;
    const ownerSubscription = subscription('owner');
    const memberSubscription = subscription('member');
    let ownerInstallation = '';
    let memberInstallation = '';

    await t.test(
      'subscriptions are authenticated, encrypted, idempotent and session-private',
      async () => {
        await mutate(anonymous.post('/v1/push/subscriptions'))
          .send(ownerSubscription)
          .expect(401);
        const config = await owner.agent.get('/v1/push/config').expect(200);
        assert.equal(config.body.enabled, true);
        assert.equal(
          config.body.publicKey,
          process.env.WEB_PUSH_VAPID_PUBLIC_KEY
        );
        assert.equal(
          JSON.stringify(config.body).includes(
            process.env.WEB_PUSH_VAPID_PRIVATE_KEY!
          ),
          false
        );
        const registered = await register(owner, ownerSubscription);
        ownerInstallation = registered.installationId;
        assert.equal(registered.enabled, true);
        assert.equal(
          (await register(owner, ownerSubscription)).installationId,
          ownerInstallation
        );
        memberInstallation = (await register(member, memberSubscription))
          .installationId;
        const stored = (
          await admin.query(
            'SELECT * FROM woori.push_installations WHERE id=$1',
            [ownerInstallation]
          )
        ).rows[0];
        for (const secret of [
          ownerSubscription.endpoint,
          ownerSubscription.keys.auth,
          ownerSubscription.keys.p256dh,
        ]) {
          assert.equal(
            JSON.stringify(stored).includes(secret),
            false,
            'Subscription secrets must be encrypted at rest'
          );
        }
        assert.equal(
          (await status(owner, ownerSubscription.endpoint)).enabled,
          true
        );
        assert.equal(
          (await status(member, ownerSubscription.endpoint)).enabled,
          false
        );
        await mutate(
          member.agent.delete(`/v1/push/subscriptions/${ownerInstallation}`)
        ).expect(404);
        assert.equal(
          (await status(owner, ownerSubscription.endpoint)).enabled,
          true
        );
      }
    );

    await t.test(
      'SSRF endpoints, malformed encryption keys and missing mutation origin are rejected',
      async () => {
        for (const endpoint of [
          'http://fcm.googleapis.com/fcm/send/token',
          'https://127.0.0.1/internal',
          'https://169.254.169.254/latest/meta-data',
          'https://fcm.googleapis.com.attacker.test/push',
          'https://user:secret@fcm.googleapis.com/fcm/send/token',
          'https://fcm.googleapis.com:444/fcm/send/token',
          'https://fcm.googleapis.com/fcm/send/token#fragment',
        ]) {
          await mutate(owner.agent.post('/v1/push/subscriptions'))
            .send({ ...ownerSubscription, endpoint })
            .expect(400);
        }
        await mutate(owner.agent.post('/v1/push/subscriptions'))
          .send({
            ...ownerSubscription,
            keys: { p256dh: 'invalid', auth: 'invalid' },
          })
          .expect(400);
        await owner.agent
          .post('/v1/push/subscriptions')
          .send(ownerSubscription)
          .expect(403);
      }
    );

    await t.test(
      'logout revokes delivery binding and same browser rebind cannot be revoked by old account',
      async () => {
        const shared = subscription('shared-browser');
        const first = await register(owner, shared);
        await mutate(owner.agent.post('/v1/auth/logout')).expect(204);
        const revoked = (
          await admin.query(
            'SELECT enabled,"revokedAt" FROM woori.push_installations WHERE id=$1',
            [first.installationId]
          )
        ).rows[0];
        assert.equal(revoked.enabled, false);
        assert.ok(revoked.revokedAt);
        const rebound = await register(member, shared);
        await mutate(owner.agent.post('/v1/auth/login'))
          .send({ username: owner.username, password })
          .expect(200);
        assert.equal((await status(owner, shared.endpoint)).enabled, false);
        await mutate(
          owner.agent.delete(`/v1/push/subscriptions/${rebound.installationId}`)
        ).expect(404);
        assert.equal((await status(member, shared.endpoint)).enabled, true);
        await mutate(
          member.agent.delete(
            `/v1/push/subscriptions/${rebound.installationId}`
          )
        ).expect(204);
        ownerInstallation = (await register(owner, ownerSubscription))
          .installationId;
      }
    );

    const groupId = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '푸시 검증 가족' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 1 })
        .expect(201)
    ).body;
    await mutate(member.agent.post('/v1/invitations/join'))
      .send({ code: invitation.code })
      .expect(200);
    const albumId = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '푸시 테스트' })
        .expect(201)
    ).body.album.id as string;
    const ownerPhoto = randomUUID();
    const memberPhoto = randomUUID();
    for (const [id, uploader] of [
      [ownerPhoto, owner.id],
      [memberPhoto, member.id],
    ]) {
      await admin.query(
        'INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES ($1,$2,$3,$4,\'READY\',1200,800,1)',
        [id, groupId, albumId, uploader]
      );
    }
    const comment = async (actor: Account, photoId = ownerPhoto) => {
      const response = await mutate(
        actor.agent.post(`/v1/photos/${photoId}/comments`)
      )
        .send({ body: `비공개 댓글 ${randomUUID()}` })
        .expect(201);
      const rows = await admin.query(
        'SELECT n.id FROM woori.notifications n WHERE n."targetId"=$1',
        [response.body.comment.id]
      );
      assert.equal(rows.rowCount, 1);
      return rows.rows[0].id as string;
    };
    const preference = async (
      account: Account,
      patch: Record<string, unknown>
    ) => {
      const current = (
        await account.agent.get('/v1/notifications/preferences').expect(200)
      ).body.preferences;
      await mutate(account.agent.patch('/v1/notifications/preferences'))
        .send({ ...patch, version: current.version })
        .expect(200);
    };
    const dispatch = async () => {
      // Repeated batches also cover fanout/dispatch separation without relying
      // on implementation-specific batch size or external timing.
      for (let index = 0; index < 3; index++) await worker.runBatch();
    };
    const drainWithoutSend = async (noticeId: string) => {
      const before = sent.length;
      await dispatch();
      assert.equal(
        sent.length,
        before,
        `Notification ${noticeId} must not be sent`
      );
    };

    await t.test(
      'failed domain transaction rolls back notification and outbox together',
      async () => {
        const commentId = randomUUID();
        let rolledBackNotice = '';
        await assert.rejects(
          app.get(PrismaService).client.$transaction(async (tx) => {
            await tx.comment.create({
              data: {
                id: commentId,
                groupId,
                photoId: ownerPhoto,
                authorId: member.id,
                body: '롤백 검증',
              },
            });
            await recordPhotoActivity(
              tx,
              ownerPhoto,
              member.id,
              'COMMENT',
              commentId
            );
            rolledBackNotice = (
              await tx.notification.findFirstOrThrow({
                where: { targetId: commentId },
              })
            ).id;
            throw new Error('intentional-transaction-rollback');
          }),
          /intentional-transaction-rollback/
        );
        assert.equal(
          (
            await admin.query('SELECT id FROM woori.comments WHERE id=$1', [
              commentId,
            ])
          ).rowCount,
          0
        );
        assert.equal(
          (
            await admin.query(
              'SELECT id FROM woori.notifications WHERE "targetId"=$1',
              [commentId]
            )
          ).rowCount,
          0
        );
        assert.ok(rolledBackNotice);
        assert.equal(
          (
            await admin.query(
              'SELECT id FROM woori.outbox_events WHERE "aggregateId"=$1',
              [rolledBackNotice]
            )
          ).rowCount,
          0
        );
      }
    );

    await t.test(
      'domain transaction creates one outbox event; concurrent workers deliver once to each intended account',
      async () => {
        const ownerNotice = await comment(member);
        const memberNotice = await comment(owner, memberPhoto);
        const outbox = await admin.query(
          'SELECT * FROM woori.outbox_events WHERE "aggregateId"=ANY($1::uuid[])',
          [[ownerNotice, memberNotice]]
        );
        assert.equal(outbox.rowCount, 2);
        assert.equal(
          JSON.stringify(outbox.rows).includes('비공개 댓글'),
          false
        );
        await Promise.all([
          worker.runBatch(),
          worker.runBatch(),
          worker.runBatch(),
        ]);
        await dispatch();
        assert.equal(sent.length, 2);
        for (const [noticeId, account, other, endpoint] of [
          [ownerNotice, owner, member, ownerSubscription.endpoint],
          [memberNotice, member, owner, memberSubscription.endpoint],
        ] as const) {
          const delivery = sent.find(
            (item) => item.payload.notificationId === noticeId
          );
          assert.ok(delivery);
          assert.equal(delivery.endpoint, endpoint);
          assert.equal(delivery.payload.recipientId, account.id);
          assert.deepEqual(Object.keys(delivery.payload).sort(), [
            'deliveryId',
            'installationId',
            'notificationId',
            'recipientId',
          ]);
          const displayPath = `/v1/push/deliveries/${delivery.payload.deliveryId}/display`;
          await other.agent.get(displayPath).expect(404);
          await anonymous.get(displayPath).expect(401);
          const display = await account.agent.get(displayPath).expect(200);
          assert.equal(
            JSON.stringify(display.body).includes('비공개 댓글'),
            false,
            'Default lockscreen preview must be generic'
          );
          assert.equal(
            JSON.stringify(display.body).includes('objectKey'),
            false
          );
          await other.agent
            .get(`/v1/notifications/${noticeId}/target`)
            .expect(404);
        }
        const count = sent.length;
        await dispatch();
        assert.equal(
          sent.length,
          count,
          'Completed delivery is not sent twice'
        );
      }
    );

    await t.test(
      'read state, global/type settings and revoked membership suppress before provider call',
      async () => {
        let notice = await comment(member);
        await mutate(owner.agent.patch(`/v1/notifications/${notice}/read`))
          .send({ throughSequence: 1 })
          .expect(200);
        await drainWithoutSend(notice);
        await preference(owner, { enabled: false });
        notice = await comment(member);
        await drainWithoutSend(notice);
        await preference(owner, { enabled: true, comments: false });
        notice = await comment(member);
        await drainWithoutSend(notice);
        await preference(owner, { comments: true });
        const current = (
          await owner.agent.get('/v1/notifications/preferences').expect(200)
        ).body.preferences;
        await mutate(
          owner.agent.put(`/v1/notifications/preferences/groups/${groupId}`)
        )
          .send({ version: current.version, mode: 'OFF' })
          .expect(200);
        notice = await comment(member);
        await drainWithoutSend(notice);
        const off = (
          await owner.agent.get('/v1/notifications/preferences').expect(200)
        ).body.preferences;
        await mutate(
          owner.agent.put(`/v1/notifications/preferences/groups/${groupId}`)
        )
          .send({ version: off.version, mode: 'DEFAULT' })
          .expect(200);
        notice = await comment(member);
        await admin.query(
          'UPDATE woori.memberships SET status=\'REMOVED\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, owner.id]
        );
        await drainWithoutSend(notice);
        await admin.query(
          'UPDATE woori.memberships SET status=\'ACTIVE\' WHERE "groupId"=$1 AND "userId"=$2',
          [groupId, owner.id]
        );
      }
    );

    await t.test(
      'expired worker lease cannot send or acknowledge a job reclaimed by another worker',
      async () => {
        const notice = await comment(member);
        const repository = app.get(PushDispatchRepository);
        while (await repository.fanOutOne()) {
          /* Drain database-only fanout. */
        }
        const first = await repository.claim();
        assert.ok(first);
        assert.equal(first.notificationId, notice);
        await admin.query(
          'UPDATE woori.notification_deliveries SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1',
          [first.id]
        );
        const second = await repository.claim();
        assert.ok(second);
        assert.equal(second.id, first.id);
        assert.notEqual(second.leaseToken, first.leaseToken);
        assert.equal(await repository.beginSend(first), false);
        await repository.finish(first, 'accepted');
        const held = (
          await admin.query(
            'SELECT status,"leaseToken" FROM woori.notification_deliveries WHERE id=$1',
            [first.id]
          )
        ).rows[0];
        assert.equal(held.status, 'RUNNING');
        assert.equal(held.leaseToken, second.leaseToken);
        assert.equal(await repository.beginSend(second), true);
        await repository.finish(second, 'accepted');
      }
    );

    await t.test(
      'quiet time holds deliveries and current read/settings are rechecked on release',
      async () => {
        const now = new Date();
        const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
        await preference(owner, {
          quietEnabled: true,
          quietStartMinute: (minute + 1438) % 1440,
          quietEndMinute: (minute + 30) % 1440,
          timeZone: 'UTC',
        });
        const notice = await comment(member);
        await drainWithoutSend(notice);
        const pending = await admin.query(
          'SELECT status FROM woori.notification_deliveries WHERE "notificationId"=$1',
          [notice]
        );
        assert.equal(pending.rowCount, 1);
        assert.notEqual(pending.rows[0].status, 'DONE');
        await mutate(owner.agent.patch(`/v1/notifications/${notice}/read`))
          .send({ throughSequence: 1 })
          .expect(200);
        await preference(owner, { quietEnabled: false });
        await admin.query(
          'UPDATE woori.notification_deliveries SET "nextAttemptAt"=now() WHERE "notificationId"=$1',
          [notice]
        );
        await drainWithoutSend(notice);
      }
    );

    await t.test(
      'display revalidates visibility even after provider accepted the opaque push',
      async () => {
        const notice = await comment(member);
        await dispatch();
        const delivered = sent.find(
          (item) => item.payload.notificationId === notice
        );
        assert.ok(delivered);
        const path = `/v1/push/deliveries/${delivered.payload.deliveryId}/display`;
        await owner.agent.get(path).expect(200);
        await admin.query(
          'UPDATE woori.photos SET "deletedAt"=now() WHERE id=$1',
          [ownerPhoto]
        );
        await owner.agent.get(path).expect(404);
        await admin.query(
          'UPDATE woori.photos SET "deletedAt"=NULL WHERE id=$1',
          [ownerPhoto]
        );
        await preference(owner, { enabled: false });
        await owner.agent.get(path).expect(404);
        await preference(owner, { enabled: true });
      }
    );

    await t.test(
      'transient provider failure retries while expired subscription is disabled',
      async () => {
        const notice = await comment(member);
        const before = sent.length;
        sendError = 503;
        await dispatch();
        assert.equal(sent.length, before);
        const retry = (
          await admin.query(
            'SELECT * FROM woori.notification_deliveries WHERE "notificationId"=$1',
            [notice]
          )
        ).rows[0];
        assert.ok(retry.attempts > 0);
        assert.ok(new Date(retry.nextAttemptAt).getTime() > Date.now());
        sendError = undefined;
        await admin.query(
          'UPDATE woori.notification_deliveries SET "nextAttemptAt"=now() WHERE "notificationId"=$1',
          [notice]
        );
        await dispatch();
        assert.equal(
          sent.filter((item) => item.payload.notificationId === notice).length,
          1
        );
        const expired = await comment(member);
        sendError = 410;
        await dispatch();
        sendError = undefined;
        assert.equal(
          (await status(owner, ownerSubscription.endpoint)).enabled,
          false
        );
        assert.equal(
          sent.some((item) => item.payload.notificationId === expired),
          false
        );
        ownerInstallation = (await register(owner, ownerSubscription))
          .installationId;
      }
    );

    await t.test(
      'session rotation and account rebind cannot deliver queued events to a different login',
      async () => {
        const notice = await comment(member);
        await mutate(owner.agent.post('/v1/auth/logout')).expect(204);
        await register(member, ownerSubscription);
        await drainWithoutSend(notice);
        await mutate(owner.agent.post('/v1/auth/login'))
          .send({ username: owner.username, password })
          .expect(200);
        await register(owner, ownerSubscription);
        await dispatch();
        assert.equal(
          sent.some((item) => item.payload.notificationId === notice),
          false,
          'Rebinding must not resurrect pre-binding notifications'
        );
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
