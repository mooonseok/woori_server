import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { AccountDeletionRepository } from '../src/domain/auth/account-deletion.repository';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { hashToken, createToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { BlocksRepository } from '../src/domain/blocks/blocks.repository';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';
import { memoryCalendar } from '../src/domain/memories/memory-date';
import { recordPhotoActivity } from '../src/domain/notifications/notification-events';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import { PushDispatchRepository } from '../src/worker/push/push-dispatch.repository';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
type Agent = ReturnType<typeof request.agent>;
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
test('isolated PostgreSQL: personal one-directional user blocks', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const password = 'blocks-integration-password-2026';
  const suffix = randomBytes(4).toString('hex');
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const fixtureInstallations: string[] = [];
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const fixtureHash = await hashPassword(password);
    // Fixture accounts and memberships use repositories so this suite does not
    // consume the shared IP signup/join quotas of unrelated suites.
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const token = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: `${label}_${suffix}`,
          email: `${label}_${suffix}@example.test`,
          displayName: label,
          nickname: label,
          passwordHash: fixtureHash,
          verifiedAt: new Date(),
        },
        hashToken(token)
      );
      agent.set('Cookie', `woori_session=${token}`);
      return { agent, id: user.id, sessionHash: hashToken(token) };
    };
    const a = await signup('b_owner_a'),
      b = await signup('b_member_b'),
      c = await signup('b_member_c'),
      d = await signup('b_outsider_d'),
      f = await signup('b_departed_f'),
      g = await signup('b_limit_g'),
      h = await signup('b_rate_h'),
      w = await signup('b_withdraw_w');
    const groupId = (
      await mutate(a.agent.post('/v1/groups'))
        .send({ name: '차단 테스트' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(a.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 50 })
        .expect(201)
    ).body;
    const join = (userId: string) =>
      app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, userId);
    for (const member of [b, c, f, g, h, w]) await join(member.id);
    const albumId = (
      await mutate(a.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '차단 앨범' })
        .expect(201)
    ).body.album.id as string;
    const album = `/v1/groups/${groupId}/albums/${albumId}`;
    const photo = async (
      uploaderId: string,
      minutesAgo: number,
      manualCapturedDate: string | null = null
    ) => {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height,"createdAt","manualCapturedDate") VALUES($1,$2,$3,$4,\'READY\',1,1,1,now()-make_interval(mins=>$5),$6)',
        [id, groupId, albumId, uploaderId, minutesAgo, manualCapturedDate]
      );
      return id;
    };
    const calendar = memoryCalendar();
    const leapDay = calendar.month === 2 && calendar.day === 29;
    const memoryDate = `${calendar.year - (leapDay ? 4 : 1)}-${String(calendar.month).padStart(2, '0')}-${String(calendar.day).padStart(2, '0')}`;
    const pA = await photo(a.id, 40),
      pC = await photo(c.id, 30),
      pB3 = await photo(b.id, 20),
      pB = await photo(b.id, 10, memoryDate);
    await admin.query(
      'INSERT INTO woori.photo_variants(id,"photoId",kind,"objectKey",mime,bytes,width,height) VALUES($1,$2,\'thumbnail\',$3,\'image/webp\',1,1,1)',
      [randomUUID(), pB, `blocks-fixture-${pB}`]
    );
    const comment = async (
      author: { agent: Agent },
      photoId: string,
      body: Record<string, unknown>
    ) =>
      (
        await mutate(author.agent.post(`/v1/photos/${photoId}/comments`))
          .send(body)
          .expect(201)
      ).body.comment.id as string;
    const react = (author: { agent: Agent }, photoId: string, emoji: string) =>
      mutate(author.agent.put(`/v1/photos/${photoId}/reactions`))
        .send({ emoji })
        .expect(200);
    const block = (agent: Agent, userId: string) =>
      mutate(agent.put(`/v1/blocks/${userId}`));
    const unblock = (agent: Agent, userId: string) =>
      mutate(agent.delete(`/v1/blocks/${userId}`));
    const commentIds = async (agent: Agent, photoId: string) => {
      const result = (
        await agent.get(`/v1/photos/${photoId}/comments`).expect(200)
      ).body;
      return {
        ids: ids(result.comments),
        total: result.total as number,
      };
    };
    const albumSummary = async (agent: Agent) =>
      (
        await agent.get(`/v1/groups/${groupId}/albums`).expect(200)
      ).body.albums.find((item: { id: string }) => item.id === albumId);
    const photoIds = async (agent: Agent) =>
      ids((await agent.get(`${album}/photos`).expect(200)).body.photos);
    const memoryIds = async (agent: Agent, kind: string) =>
      (
        await agent
          .get(`/v1/groups/${groupId}/memories`)
          .query({ kind, limit: 30 })
          .expect(200)
      ).body.items.map((item: { photo: { id: string } }) => item.photo.id);

    // Content and notifications created before the block.
    const ec = createECDH('prime256v1');
    ec.generateKeys();
    const installationId = (
      await mutate(a.agent.post('/v1/push/subscriptions'))
        .send({
          endpoint: `https://fcm.googleapis.com/fcm/send/blocks-${randomUUID()}`,
          keys: {
            p256dh: ec.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
          expirationTime: null,
        })
        .expect(201)
    ).body.installationId as string;
    fixtureInstallations.push(installationId);
    const commentB = await comment(b, pA, {
      body: 'B의 댓글',
      kind: 'GENERAL',
    });
    const pinB = await comment(b, pA, {
      body: 'B의 위치 댓글',
      kind: 'PIN',
      x: 0.5,
      y: 0.5,
    });
    const commentC = await comment(c, pA, {
      body: 'C의 댓글',
      kind: 'GENERAL',
    });
    await react(b, pA, '❤️');
    await react(c, pA, '😂');
    await react(a, pA, '❤️');
    await app
      .get(PrismaService)
      .client.$transaction((tx) =>
        recordPhotoActivity(tx, pB, b.id, 'PHOTOS', pB)
      );
    await mutate(a.agent.put(`/v1/groups/${groupId}/memories/${pB3}/hidden`))
      .send({})
      .expect(204);
    const dispatcher = new PushDispatchRepository(app.get(PrismaService));
    while (await dispatcher.fanOutOne()) {
      /* fan out every pending event; no push is sent */
    }
    const fromActor = async (recipientId: string, actorId: string) =>
      ids(
        (
          await admin.query(
            'SELECT n.id FROM woori.notifications n WHERE n."recipientId"=$1 AND EXISTS(SELECT 1 FROM woori.notification_activities x WHERE x."notificationId"=n.id AND x."actorId"=$2) ORDER BY n.id',
            [recipientId, actorId]
          )
        ).rows
      );
    const countFor = async (table: string, column: string, values: string[]) =>
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM woori.${table} WHERE "${column}"=ANY($1::uuid[])`,
          [values]
        )
      ).rows[0].n as number;
    const erasedNotifications = await fromActor(a.id, b.id);
    let race = { notificationId: '', deliveryId: '' };
    let offPhoto = { notificationId: '', deliveryId: '' };

    await t.test(
      'migration enables RLS and the runtime role can add and remove but not update blocks',
      async () => {
        const rls = await admin.query(
          "SELECT c.relrowsecurity, EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='woori' AND p.tablename='user_blocks' AND p.policyname='server_api_access') AS policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='woori' AND c.relname='user_blocks'"
        );
        assert.deepEqual(rls.rows, [{ relrowsecurity: true, policy: true }]);
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = (
            await runtime.query(
              "SELECT has_table_privilege(current_user, 'woori.user_blocks', 'SELECT') AS read, has_table_privilege(current_user, 'woori.user_blocks', 'INSERT') AS insert, has_table_privilege(current_user, 'woori.user_blocks', 'UPDATE') AS update, has_table_privilege(current_user, 'woori.user_blocks', 'DELETE') AS delete, has_table_privilege(current_user, 'woori.user_blocks', 'TRUNCATE') AS truncate"
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            read: true,
            insert: true,
            update: false,
            delete: true,
            truncate: false,
          });
          await assert.rejects(
            runtime.query('UPDATE woori.user_blocks SET "createdAt"=now()'),
            (error: { code?: string }) => error.code === '42501'
          );
        } finally {
          await runtime.end();
        }
      }
    );

    await t.test(
      'block routes require a session, CSRF headers and a visible other user',
      async () => {
        for (const result of [
          await api.get('/v1/blocks').expect(401),
          await mutate(api.put(`/v1/blocks/${b.id}`)).expect(401),
          await mutate(api.delete(`/v1/blocks/${b.id}`)).expect(401),
        ])
          assert.equal(result.body.code, 'AUTHENTICATION_REQUIRED');
        for (const op of [
          a.agent.put(`/v1/blocks/${b.id}`),
          a.agent.delete(`/v1/blocks/${b.id}`),
        ]) {
          const result = await op.expect(403);
          assert.equal(result.body.code, 'REQUEST_ORIGIN_REJECTED');
        }
        // The path id is normalized: an uppercase spelling of one's own id is self.
        for (const op of [
          block(a.agent, a.id),
          unblock(a.agent, a.id),
          block(a.agent, a.id.toUpperCase()),
          unblock(a.agent, a.id.toUpperCase()),
        ]) {
          const result = await op.expect(400);
          assert.equal(result.body.code, 'BLOCK_SELF_NOT_ALLOWED');
        }
        for (const id of [d.id, randomUUID()]) {
          const result = await block(a.agent, id).expect(404);
          assert.equal(result.body.code, 'USER_NOT_FOUND');
        }
        await block(a.agent, 'not-a-uuid').expect(400);
        await unblock(a.agent, 'not-a-uuid').expect(400);
        // The outsider cannot see group members either.
        await block(d.agent, b.id).expect(404);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.user_blocks WHERE "blockerId"=ANY($1::uuid[])',
              [[a.id, d.id]]
            )
          ).rows[0].n,
          0
        );
        // Baseline before the block: A sees B's content.
        assert.equal((await albumSummary(a.agent)).photoCount, 4);
        assert.ok((await photoIds(a.agent)).includes(pB));
        assert.ok(erasedNotifications.length >= 3);
        assert.ok(
          (await countFor(
            'notification_deliveries',
            'notificationId',
            erasedNotifications
          )) > 0
        );
      }
    );

    let blockedAt = '';
    await t.test(
      'blocking is idempotent and erases the blocker’s notifications from that user',
      async () => {
        const first = await block(a.agent, b.id.toUpperCase()).expect(200);
        assert.equal(first.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(first.body).sort(), [
          'blockedAt',
          'displayName',
          'nickname',
          'userId',
        ]);
        assert.equal(first.body.userId, b.id);
        assert.equal(first.body.displayName, 'b_member_b');
        blockedAt = first.body.blockedAt;
        const again = await block(a.agent, b.id).expect(200);
        assert.equal(again.body.blockedAt, blockedAt);
        for (const [table, column] of [
          ['notifications', 'id'],
          ['notification_activities', 'notificationId'],
          ['notification_deliveries', 'notificationId'],
          ['outbox_events', 'aggregateId'],
        ])
          assert.equal(
            await countFor(table, column, erasedNotifications),
            0,
            table
          );
        // Only the blocker's rows: C keeps B's photo notification.
        assert.equal((await fromActor(c.id, b.id)).length, 1);
        // Membership and roles never change.
        assert.equal(
          (
            await admin.query(
              'SELECT status,role FROM woori.memberships WHERE "groupId"=$1 AND "userId"=$2',
              [groupId, b.id]
            )
          ).rows[0].status,
          'ACTIVE'
        );
      }
    );

    await t.test(
      'the blocker no longer sees the blocked user’s photos, comments or reactions; others do',
      async () => {
        const forA = await albumSummary(a.agent),
          forC = await albumSummary(c.agent);
        assert.equal(forA.photoCount, 2);
        assert.equal(forA.coverPhotoId, pC);
        assert.equal(forC.photoCount, 4);
        assert.equal(forC.coverPhotoId, pB);
        assert.deepEqual(await photoIds(a.agent), [pC, pA]);
        assert.deepEqual(await photoIds(c.agent), [pB, pB3, pC, pA]);
        const listed = (await c.agent.get(`${album}/photos`).expect(200)).body
          .photos;
        assert.deepEqual(
          listed.find((item: { id: string }) => item.id === pB).uploader,
          { id: b.id, displayName: 'b_member_b', nickname: 'b_member_b' }
        );
        const stale = await a.agent
          .get(`${album}/photos`)
          .query({ cursor: pB })
          .expect(404);
        assert.equal(stale.body.code, 'PHOTO_NOT_FOUND');
        // Content proxy is checked before storage access.
        const content = await a.agent
          .get(`${album}/photos/${pB}/content`)
          .query({ variant: 'thumbnail' })
          .expect(404);
        assert.equal(content.body.code, 'PHOTO_NOT_FOUND');
        const photos = app.get(PhotosRepository);
        await assert.rejects(
          photos.content(groupId, albumId, pB, a.id, 'THUMBNAIL')
        );
        assert.ok(
          await photos.content(groupId, albumId, pB, c.id, 'THUMBNAIL')
        );
        // Comments and totals use one predicate, including the raw cursor page.
        const aComments = await commentIds(a.agent, pA);
        assert.deepEqual(aComments.ids, [commentC]);
        assert.equal(aComments.total, 1);
        const cComments = await commentIds(c.agent, pA);
        assert.deepEqual(
          new Set(cComments.ids),
          new Set([commentB, pinB, commentC])
        );
        assert.equal(cComments.total, 3);
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const query: Record<string, string | number> = { limit: 1 };
          if (cursor) query.cursor = cursor;
          const page = (
            await a.agent
              .get(`/v1/photos/${pA}/comments`)
              .query(query)
              .expect(200)
          ).body;
          assert.equal(page.total, 1);
          paged.push(...ids(page.comments));
          cursor = page.nextCursor;
        } while (cursor && paged.length < 10);
        assert.deepEqual(paged, [commentC]);
        for (const path of [
          `/v1/photos/${pB}/comments`,
          `/v1/photos/${pB}/reactions`,
        ]) {
          const missing = await a.agent.get(path).expect(404);
          assert.equal(missing.body.code, 'PHOTO_NOT_FOUND');
        }
        await mutate(a.agent.put(`/v1/photos/${pB}/reactions`))
          .send({ emoji: '👏' })
          .expect(404);
        const aReactions = (
          await a.agent.get(`/v1/photos/${pA}/reactions`).expect(200)
        ).body;
        assert.deepEqual(aReactions, {
          reactions: [
            { emoji: '❤️', count: 1 },
            { emoji: '😂', count: 1 },
          ],
          myReaction: '❤️',
          total: 2,
        });
        const changed = (
          await mutate(a.agent.put(`/v1/photos/${pA}/reactions`))
            .send({ emoji: '❤️' })
            .expect(200)
        ).body;
        assert.equal(changed.total, 2);
        const cReactions = (
          await c.agent.get(`/v1/photos/${pA}/reactions`).expect(200)
        ).body;
        assert.equal(cReactions.total, 3);
        // The blocked user's own view and permissions are unchanged.
        assert.deepEqual(await photoIds(b.agent), [pB, pB3, pC, pA]);
        const late = await comment(b, pA, {
          body: '차단 후 B의 댓글',
          kind: 'GENERAL',
        });
        assert.ok((await commentIds(b.agent, pA)).ids.includes(late));
        assert.ok(!(await commentIds(a.agent, pA)).ids.includes(late));
        assert.ok((await commentIds(c.agent, pA)).ids.includes(late));
      }
    );

    await t.test(
      'memories, capture-date edits and photo deletion follow the same visibility',
      async () => {
        assert.ok(!(await memoryIds(a.agent, 'today')).includes(pB));
        assert.ok((await memoryIds(c.agent, 'today')).includes(pB));
        const cToday = (
          await c.agent
            .get(`/v1/groups/${groupId}/memories`)
            .query({ kind: 'today' })
            .expect(200)
        ).body.items.find(
          (item: { photo: { id: string } }) => item.photo.id === pB
        );
        assert.deepEqual(cToday.photo.uploader, {
          id: b.id,
          displayName: 'b_member_b',
          nickname: 'b_member_b',
        });
        assert.equal(cToday.uploader, undefined);
        assert.ok(!(await memoryIds(a.agent, 'hidden')).includes(pB3));
        for (const op of [
          mutate(
            a.agent.delete(`/v1/groups/${groupId}/memories/${pB3}/hidden`)
          ).send({}),
          mutate(
            a.agent.put(`/v1/groups/${groupId}/memories/${pB}/hidden`)
          ).send({}),
          mutate(a.agent.patch(`${album}/photos/${pB}/capture-date`)).send({
            date: '2020-01-01',
          }),
          mutate(a.agent.delete(`${album}/photos/${pB}`)),
        ]) {
          const result = await op.expect(404);
          assert.equal(result.body.code, 'PHOTO_NOT_FOUND');
        }
        // Other MediaPhoto responses also carry the uploader.
        const edited = (
          await mutate(a.agent.patch(`${album}/photos/${pA}/capture-date`))
            .send({ date: null })
            .expect(200)
        ).body.photo;
        assert.deepEqual(edited.uploader, {
          id: a.id,
          displayName: 'b_owner_a',
          nickname: 'b_owner_a',
        });
        const queued = await photo(a.id, 50);
        await admin.query(
          'UPDATE woori.photos SET "processingQueuedAt"=now() WHERE id=$1',
          [queued]
        );
        const processing = (
          await a.agent.get(`${album}/photos/${queued}/processing`).expect(200)
        ).body;
        assert.equal(processing.status, 'READY');
        assert.deepEqual(processing.photo.uploader, {
          id: a.id,
          displayName: 'b_owner_a',
          nickname: 'b_owner_a',
        });
        const uploads = (await a.agent.get(`${album}/uploads`).expect(200)).body
          .uploads;
        assert.deepEqual(
          uploads.find((item: { photoId: string }) => item.photoId === queued)
            .photo.uploader,
          { id: a.id, displayName: 'b_owner_a', nickname: 'b_owner_a' }
        );
        const kept = (
          await admin.query(
            'SELECT status,"deletedAt","manualCapturedDate"::text AS date FROM woori.photos WHERE id=$1',
            [pB]
          )
        ).rows[0];
        assert.deepEqual(kept, {
          status: 'READY',
          deletedAt: null,
          date: memoryDate,
        });
      }
    );

    await t.test(
      'new activity by the blocked user never reaches the blocker’s inbox or push',
      async () => {
        const before = await fromActor(c.id, b.id);
        const activitiesFor = async (recipientId: string, actorId: string) =>
          (
            await admin.query(
              'SELECT x."photoId" FROM woori.notification_activities x JOIN woori.notifications n ON n.id=x."notificationId" WHERE n."recipientId"=$1 AND x."actorId"=$2',
              [recipientId, actorId]
            )
          ).rows.map((row: { photoId: string | null }) => row.photoId);
        const beforeActivities = await activitiesFor(c.id, b.id);
        await comment(b, pA, { body: '알림 없어야 함', kind: 'GENERAL' });
        await react(b, pA, '👏');
        const pNew = await photo(b.id, 1);
        await app
          .get(PrismaService)
          .client.$transaction((tx) =>
            recordPhotoActivity(tx, pNew, b.id, 'PHOTOS', pNew)
          );
        assert.deepEqual(await fromActor(a.id, b.id), []);
        // W07 upload bundling: B's new photo reaches C as exactly one more
        // activity of C's open B/album bundle (same uploader + album within 10
        // minutes), not as a second row.
        assert.deepEqual(await fromActor(c.id, b.id), before);
        const afterActivities = await activitiesFor(c.id, b.id);
        assert.equal(afterActivities.length, beforeActivities.length + 1);
        assert.equal(
          afterActivities.filter((photoId) => photoId === pNew).length,
          1
        );
        // A notification that slipped in concurrently (inserted directly here)
        // is still hidden by every read path and push eligibility.
        const binding = (
          await admin.query(
            'SELECT "bindingVersion" FROM woori.push_installations WHERE id=$1',
            [installationId]
          )
        ).rows[0].bindingVersion as number;
        const direct = async (actorId: string, targetId: string) => {
          const notificationId = randomUUID(),
            deliveryId = randomUUID();
          await admin.query(
            'INSERT INTO woori.notifications(id,"recipientId","groupId",kind,"targetId","dedupeKey") VALUES($1,$2,$3,\'COMMENT\',$4,$5)',
            [
              notificationId,
              a.id,
              groupId,
              targetId,
              `fixture:${notificationId}`,
            ]
          );
          await admin.query(
            'INSERT INTO woori.notification_activities(id,"notificationId","actorId",sequence,"eventKey") VALUES($1,$2,$3,1,$4)',
            [randomUUID(), notificationId, actorId, `fixture:${notificationId}`]
          );
          await admin.query(
            'INSERT INTO woori.notification_deliveries(id,"notificationId","installationId","deliveryKey",status,"bindingVersion") VALUES($1,$2,$3,$4,\'RUNNING\',$5)',
            [
              deliveryId,
              notificationId,
              installationId,
              `fixture:${deliveryId}`,
              binding,
            ]
          );
          return { notificationId, deliveryId };
        };
        const hidden = await direct(b.id, commentB);
        const control = await direct(c.id, commentC);
        // Actor C is not blocked, but the target photo's uploader B is: the
        // photo is invisible to A, so this notification is hidden too.
        offPhoto = await direct(
          c.id,
          await comment(c, pB, {
            body: 'B의 사진에 C가 남긴 댓글',
            kind: 'GENERAL',
          })
        );
        race = hidden;
        assert.equal(await dispatcher.eligibility(offPhoto.deliveryId), null);
        const offTarget = await a.agent
          .get(`/v1/notifications/${offPhoto.notificationId}/target`)
          .expect(404);
        assert.equal(offTarget.body.code, 'NOTIFICATION_NOT_FOUND');
        const controlTarget = (
          await a.agent
            .get(`/v1/notifications/${control.notificationId}/target`)
            .expect(200)
        ).body;
        // Exact shape; OpenAPI 0.20.0 added navigation (COMMENT for a comment),
        // 0.24.0 the target media's kind.
        assert.deepEqual(Object.keys(controlTarget).sort(), [
          'albumId',
          'commentId',
          'groupId',
          'latestSequence',
          'mediaKind',
          'navigation',
          'photoId',
          'uploader',
        ]);
        assert.equal(controlTarget.navigation, 'COMMENT');
        assert.equal(controlTarget.mediaKind, 'PHOTO');
        assert.deepEqual(controlTarget.uploader, {
          id: a.id,
          displayName: 'b_owner_a',
          nickname: 'b_owner_a',
        });
        assert.equal(await dispatcher.eligibility(hidden.deliveryId), null);
        const eligible = await dispatcher.eligibility(control.deliveryId);
        assert.equal(eligible?.decision.action, 'send');
        await a.agent
          .get(`/v1/push/deliveries/${hidden.deliveryId}/display`)
          .expect(404);
        await a.agent
          .get(`/v1/push/deliveries/${control.deliveryId}/display`)
          .expect(200);
        const inbox = (await a.agent.get('/v1/notifications').expect(200)).body;
        const inboxIds = ids(inbox.notifications);
        assert.ok(!inboxIds.includes(hidden.notificationId));
        assert.ok(!inboxIds.includes(offPhoto.notificationId));
        assert.ok(inboxIds.includes(control.notificationId));
        // Inbox items keep their shape (no uploader field there).
        assert.ok(
          inbox.notifications.every(
            (item: Record<string, unknown>) => !('uploaderId' in item)
          )
        );
        assert.equal(
          inbox.unreadCount,
          inbox.notifications.filter((n: { unread: boolean }) => n.unread)
            .length
        );
        await a.agent
          .get(`/v1/notifications/${hidden.notificationId}/target`)
          .expect(404);
        await mutate(
          a.agent.patch(`/v1/notifications/${hidden.notificationId}/read`)
        )
          .send({ throughSequence: 1 })
          .expect(404);
        await mutate(a.agent.post('/v1/notifications/read-all'))
          .send({
            notifications: [
              { id: hidden.notificationId, throughSequence: 1 },
              { id: control.notificationId, throughSequence: 1 },
            ],
          })
          .expect(404);
        // The A<-B race row stays until unblocking, which must erase it.
        await admin.query(
          'DELETE FROM woori.notification_deliveries WHERE "notificationId"=$1',
          [control.notificationId]
        );
        await admin.query(
          'DELETE FROM woori.notification_activities WHERE "notificationId"=$1',
          [control.notificationId]
        );
        await admin.query('DELETE FROM woori.notifications WHERE id=$1', [
          control.notificationId,
        ]);
      }
    );

    await t.test(
      'the roster keeps blocked members with a blocker-only flag',
      async () => {
        const flags = async (agent: Agent) =>
          Object.fromEntries(
            (
              await agent
                .get(`/v1/groups/${groupId}/members`)
                .query({ limit: 50 })
                .expect(200)
            ).body.members.map(
              (member: { userId: string; blockedByMe: boolean }) => [
                member.userId,
                member.blockedByMe,
              ]
            )
          );
        const forA = await flags(a.agent),
          forC = await flags(c.agent);
        assert.equal(forA[b.id], true);
        assert.equal(forA[c.id], false);
        assert.equal(forC[b.id], false);
        assert.equal(forC[a.id], false);
      }
    );

    await t.test(
      'a withdrawn author stays blockable through retained content',
      async () => {
        const retained = await comment(f, pA, {
          body: '탈퇴 전 댓글',
          kind: 'GENERAL',
        });
        await mutate(f.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        const result = await block(a.agent, f.id).expect(200);
        assert.equal(result.body.displayName, '탈퇴한 회원');
        assert.ok(!(await commentIds(a.agent, pA)).ids.includes(retained));
        assert.ok((await commentIds(c.agent, pA)).ids.includes(retained));
        // Without shared membership or content an account is not blockable.
        await block(c.agent, d.id).expect(404);
      }
    );

    await t.test(
      'the block list pages newest first and rejects stale cursors',
      async () => {
        const all = (await a.agent.get('/v1/blocks').expect(200)).body;
        assert.equal(all.nextCursor, null);
        assert.deepEqual(
          all.items.map((item: { userId: string }) => item.userId),
          [f.id, b.id]
        );
        for (const item of all.items)
          assert.deepEqual(Object.keys(item).sort(), [
            'blockedAt',
            'displayName',
            'nickname',
            'userId',
          ]);
        assert.equal(all.items[1].blockedAt, blockedAt);
        const first = (
          await a.agent.get('/v1/blocks').query({ limit: 1 }).expect(200)
        ).body;
        assert.deepEqual(
          first.items.map((item: { userId: string }) => item.userId),
          [f.id]
        );
        assert.equal(first.nextCursor, f.id);
        const second = (
          await a.agent
            .get('/v1/blocks')
            .query({ limit: 1, cursor: first.nextCursor })
            .expect(200)
        ).body;
        assert.deepEqual(
          second.items.map((item: { userId: string }) => item.userId),
          [b.id]
        );
        assert.equal(second.nextCursor, null);
        const stale = await a.agent
          .get('/v1/blocks')
          .query({ cursor: c.id })
          .expect(404);
        assert.equal(stale.body.code, 'USER_NOT_FOUND');
        for (const query of [{ limit: 0 }, { limit: 51 }, { cursor: 'x' }])
          await a.agent.get('/v1/blocks').query(query).expect(400);
        assert.deepEqual((await c.agent.get('/v1/blocks').expect(200)).body, {
          items: [],
          nextCursor: null,
        });
      }
    );

    await t.test(
      'the 501st block is rejected and block changes are rate limited',
      async () => {
        const synthetic = Array.from({ length: 500 }, () => randomUUID());
        await admin.query(
          "INSERT INTO woori.users(id,username,\"displayName\",email,\"passwordHash\") SELECT id, $2 || i, 'synthetic', $2 || i || '@example.test', '' FROM unnest($1::uuid[]) WITH ORDINALITY AS s(id,i)",
          [synthetic, `blocklimit_${suffix}_`]
        );
        await admin.query(
          'INSERT INTO woori.user_blocks("blockerId","blockedId") SELECT $1, id FROM unnest($2::uuid[]) AS s(id)',
          [g.id, synthetic]
        );
        const limited = await block(g.agent, b.id).expect(409);
        assert.equal(limited.body.code, 'BLOCK_LIMIT_REACHED');
        // An existing block is still answered at the limit.
        await block(g.agent, synthetic[0]).expect(200);
        const bucket = rateLimitKey(
          'auth',
          `user-block:${h.id}`,
          new Date(),
          60 * 60 * 1000
        );
        await admin.query(
          'INSERT INTO woori.rate_limit_buckets (id,"windowStart",attempts) VALUES ($1,$2,60) ON CONFLICT(id) DO UPDATE SET attempts=60',
          [bucket.id, bucket.windowStart]
        );
        for (const op of [block(h.agent, c.id), unblock(h.agent, c.id)]) {
          const result = await op.expect(429);
          assert.equal(result.body.code, 'TOO_MANY_REQUESTS');
        }
        await block(c.agent, h.id).expect(200);
        await unblock(c.agent, h.id).expect(204);
      }
    );

    await t.test(
      'unblocking restores content only, not erased notifications',
      async () => {
        // Unblocking when not blocked never erases anything.
        const cFromB = await fromActor(c.id, b.id);
        await unblock(c.agent, b.id).expect(204);
        assert.deepEqual(await fromActor(c.id, b.id), cFromB);
        assert.ok(race.notificationId);
        await unblock(a.agent, b.id.toUpperCase()).expect(204);
        await unblock(a.agent, b.id).expect(204);
        await unblock(a.agent, d.id).expect(204);
        // The notification that raced the block is erased, not resurrected.
        for (const [table, column] of [
          ['notifications', 'id'],
          ['notification_activities', 'notificationId'],
          ['notification_deliveries', 'notificationId'],
        ])
          assert.equal(
            await countFor(table, column, [race.notificationId]),
            0,
            table
          );
        assert.ok(
          !ids(
            (await a.agent.get('/v1/notifications').expect(200)).body
              .notifications
          ).includes(race.notificationId)
        );
        // The C-actor notification on B's photo is visible again and names the
        // photo uploader, which differs from the actor.
        const offTarget = (
          await a.agent
            .get(`/v1/notifications/${offPhoto.notificationId}/target`)
            .expect(200)
        ).body;
        assert.equal(offTarget.photoId, pB);
        assert.deepEqual(offTarget.uploader, {
          id: b.id,
          displayName: 'b_member_b',
          nickname: 'b_member_b',
        });
        assert.equal((await albumSummary(a.agent)).photoCount, 6);
        assert.ok((await photoIds(a.agent)).includes(pB));
        assert.equal((await commentIds(a.agent, pA)).total, 5);
        assert.ok((await memoryIds(a.agent, 'hidden')).includes(pB3));
        assert.ok((await memoryIds(a.agent, 'today')).includes(pB));
        assert.equal(
          await countFor('notifications', 'id', erasedNotifications),
          0
        );
        const unblockedFlags = (
          await a.agent
            .get(`/v1/groups/${groupId}/members`)
            .query({ limit: 50 })
            .expect(200)
        ).body.members.find(
          (member: { userId: string }) => member.userId === b.id
        );
        assert.equal(unblockedFlags.blockedByMe, false);
      }
    );

    await t.test(
      'withdrawal removes the withdrawing user’s blocks but keeps blocks on them',
      async () => {
        await block(w.agent, b.id).expect(200);
        await mutate(w.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.user_blocks WHERE "blockerId"=$1',
              [w.id]
            )
          ).rows[0].n,
          0
        );
        await block(a.agent, b.id).expect(200);
        await mutate(b.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.user_blocks WHERE "blockerId"=$1 AND "blockedId"=$2',
              [a.id, b.id]
            )
          ).rows[0].n,
          1
        );
        assert.ok(!(await photoIds(a.agent)).includes(pB));
        assert.ok((await photoIds(c.agent)).includes(pB));
        assert.ok(!(await commentIds(a.agent, pA)).ids.includes(commentB));
        const listed = (await a.agent.get('/v1/blocks').expect(200)).body.items;
        assert.equal(
          listed.find((item: { userId: string }) => item.userId === b.id)
            .displayName,
          '탈퇴한 회원'
        );
      }
    );

    await t.test(
      'a block racing its blocker’s withdrawal leaves no block row',
      async () => {
        for (let round = 0; round < 3; round++) {
          const racer = await signup(`b_race${round}`);
          await join(racer.id);
          const results = await Promise.allSettled([
            app
              .get(AccountDeletionRepository)
              .delete(racer.id, racer.sessionHash, fixtureHash),
            app.get(BlocksRepository).block(racer.id, c.id, racer.sessionHash),
          ]);
          assert.equal(results[0].status, 'fulfilled');
          if (results[1].status === 'rejected')
            assert.ok(
              [401, 404].includes(results[1].reason?.getStatus?.()),
              String(results[1].reason)
            );
          assert.equal(
            (
              await admin.query(
                'SELECT count(*)::int AS n FROM woori.user_blocks WHERE "blockerId"=$1',
                [racer.id]
              )
            ).rows[0].n,
            0
          );
        }
      }
    );

    await t.test(
      'erasure deletes and the delivery foreign-key check can use the new indexes',
      async (explain) => {
        const one = randomUUID(),
          two = randomUUID();
        const statements = {
          deliveries: `DELETE FROM woori.notification_deliveries WHERE "notificationId" IN ('${one}','${two}')`,
          outbox: `DELETE FROM woori.outbox_events WHERE type='NOTIFICATION_PUSH' AND "aggregateId" IN ('${one}'::uuid,'${two}'::uuid)`,
          foreignKey: `SELECT 1 FROM ONLY woori.notification_deliveries x WHERE "notificationId"='${one}'::uuid FOR KEY SHARE OF x`,
          accountOutbox: `DELETE FROM woori.outbox_events WHERE type='NOTIFICATION_PUSH' AND "aggregateId" IN (SELECT id FROM woori.notifications WHERE "recipientId"='${one}'::uuid)`,
        };
        const client = await admin.connect();
        const plan = async (sql: string) =>
          (await client.query(`EXPLAIN ${sql}`)).rows
            .map((row: Record<string, string>) => row['QUERY PLAN'])
            .join(' | ');
        try {
          await client.query('BEGIN');
          for (const [name, sql] of Object.entries(statements))
            explain.diagnostic(`default ${name}: ${await plan(sql)}`);
          // Disabling sequential scans shows whether an index is usable; the
          // planner's cost choice on tiny test tables is reported above only.
          await client.query('SET LOCAL enable_seqscan = off');
          const forced = {
            deliveries: await plan(statements.deliveries),
            outbox: await plan(statements.outbox),
            foreignKey: await plan(statements.foreignKey),
          };
          for (const [name, text] of Object.entries(forced))
            explain.diagnostic(`forced ${name}: ${text}`);
          assert.match(
            forced.deliveries,
            /notification_deliveries_notificationId_idx/
          );
          assert.match(
            forced.foreignKey,
            /notification_deliveries_notificationId_idx/
          );
          assert.match(forced.outbox, /outbox_events_aggregateId_idx/);
          explain.diagnostic(
            `forced accountOutbox: ${await plan(statements.accountOutbox)}`
          );
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    );
  } finally {
    // The runner shares one isolated DB across suites. Retire only this suite's
    // push fixture and drain its outbox so a later push worker test never sends
    // this suite's notifications.
    if (fixtureInstallations.length) {
      await admin.query(
        'UPDATE woori.push_installations SET enabled=false,"revokedAt"=now() WHERE id=ANY($1::uuid[])',
        [fixtureInstallations]
      );
      await admin.query(
        'UPDATE woori.notification_deliveries SET status=\'DONE\',"resultCode"=\'fixture-cleanup\',"leaseToken"=NULL,"leaseUntil"=NULL WHERE "installationId"=ANY($1::uuid[]) AND status IN (\'PENDING\',\'RUNNING\')',
        [fixtureInstallations]
      );
      const dispatcher = new PushDispatchRepository(app.get(PrismaService));
      while (await dispatcher.fanOutOne()) {
        /* no installation remains for this suite's recipients */
      }
    }
    await app.close();
    await admin.end();
  }
});
