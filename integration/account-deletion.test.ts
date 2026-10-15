import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createECDH } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { AccountDeletionRepository } from '../src/domain/auth/account-deletion.repository';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { GroupsRepository } from '../src/domain/groups/groups.repository';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { GroupManagementRepository } from '../src/domain/groups/group-management.repository';
import { PhotoInteractionsRepository } from '../src/domain/photos/photo-interactions.repository';
import { MemoriesRepository } from '../src/domain/memories/memories.repository';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import { hashToken, createToken } from '../src/domain/auth/auth-token';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { PushRepository } from '../src/domain/push/push.repository';
import { PushDispatchRepository } from '../src/worker/push/push-dispatch.repository';
import { hashPassword } from '../src/domain/auth/password';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
test('isolated PostgreSQL: account deletion preserves shared content and erases private credentials', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const fixtureCleanupPhotoIds: string[] = [];
  const password = 'deletion-integration-password-2026';
  const suffix = randomBytes(4).toString('hex');
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const fixtureHash = await hashPassword(password);
    const expectedRace = (results: PromiseSettledResult<unknown>[]) => {
      assert.ok(results.some((r) => r.status === 'fulfilled'));
      for (const result of results)
        if (result.status === 'rejected')
          assert.ok(
            [401, 404, 409].includes(result.reason?.getStatus?.()),
            String(result.reason)
          );
    };
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const data = {
        username: `${label}_${suffix}`,
        email: `${label}_${suffix}@example.test`,
        displayName: label,
        password,
      };
      // Fixture setup uses the repository so this suite does not consume the
      // shared IP signup quota of unrelated integration suites. Re-registration
      // below still exercises the real public signup endpoint.
      const token = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: data.username,
          email: data.email,
          displayName: data.displayName,
          passwordHash: fixtureHash,
          verifiedAt: new Date(),
        },
        hashToken(token)
      );
      const id = user.id;
      const cookie = `woori_session=${token}`;
      agent.set('Cookie', cookie);
      const hash = fixtureHash;
      return {
        agent,
        id,
        data,
        cookie,
        hash,
        sessionHash: hashToken(cookie.split('=')[1]),
      };
    };
    const owner = await signup('d_owner'),
      member = await signup('d_member'),
      outsider = await signup('d_out');
    const groupId = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '공유 유지' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 50 })
        .expect(201)
    ).body;
    await mutate(member.agent.post('/v1/invitations/join'))
      .send({ code: invitation.code })
      .expect(200);
    const albumId = (
      await mutate(member.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '공유 사진집' })
        .expect(201)
    ).body.album.id as string;
    const photoId = randomUUID(),
      pendingId = randomUUID(),
      processingId = randomUUID();
    fixtureCleanupPhotoIds.push(pendingId, processingId);
    await admin.query(
      'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) VALUES($1,$2,$3,$4,\'READY\',123,1,1)',
      [photoId, groupId, albumId, member.id]
    );
    await admin.query('UPDATE woori.groups SET "usedBytes"=123 WHERE id=$1', [
      groupId,
    ]);
    await admin.query(
      "INSERT INTO woori.photo_variants(id,\"photoId\",kind,\"objectKey\",mime,bytes,width,height) VALUES($1,$2,'original','shared-original-fixture','image/png',123,1,1)",
      [randomUUID(), photoId]
    );
    for (const [id, status] of [
      [pendingId, 'PENDING'],
      [processingId, 'PROCESSING'],
    ])
      await admin.query(
        'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,"stagingKey","reservedBytes","uploadExpiresAt","processingToken","processingUntil") VALUES($1,$2,$3,$4,$5, $6,123,now()+interval \'10 minutes\',$7,now()+interval \'5 minutes\')',
        [id, groupId, albumId, member.id, status, `staging-${id}`, randomUUID()]
      );
    const general = (
      await mutate(member.agent.post(`/v1/photos/${photoId}/comments`))
        .send({ body: '남겨 둘 이야기', kind: 'GENERAL' })
        .expect(201)
    ).body.comment;
    await mutate(member.agent.post(`/v1/photos/${photoId}/comments`))
      .send({ body: '이 자리', kind: 'PIN', x: 0.2, y: 0.3 })
      .expect(201);
    await mutate(member.agent.put(`/v1/photos/${photoId}/reactions`))
      .send({ emoji: '❤️' })
      .expect(200);
    await mutate(owner.agent.post(`/v1/photos/${photoId}/comments`))
      .send({ body: '회원에게 알림', kind: 'GENERAL' })
      .expect(201);
    const device = request.agent(app.getHttpServer());
    await mutate(device.post('/v1/auth/login'))
      .send({ username: member.data.username, password })
      .expect(200);
    const ec = createECDH('prime256v1');
    ec.generateKeys();
    await mutate(member.agent.post('/v1/push/subscriptions'))
      .send({
        endpoint: `https://fcm.googleapis.com/fcm/send/deletion-${randomUUID()}`,
        keys: {
          p256dh: ec.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
        expirationTime: null,
      })
      .expect(201);
    await admin.query(
      'INSERT INTO woori.notification_preferences("userId",enabled) VALUES($1,true)',
      [member.id]
    );
    await admin.query(
      'INSERT INTO woori.group_notification_preferences("userId","groupId",mode) VALUES($1,$2,\'MINE\')',
      [member.id, groupId]
    );
    await admin.query(
      'INSERT INTO woori.photo_memory_preferences("userId","photoId","hiddenAt") VALUES($1,$2,now())',
      [member.id, photoId]
    );
    const changeToken = createToken();
    await admin.query(
      'INSERT INTO woori.email_tokens(id,"userId","tokenHash",purpose,"targetEmail","expiresAt") VALUES($1,$2,$3,\'CHANGE_EMAIL\',\'private-target@example.test\',now()+interval \'10 minutes\')',
      [randomUUID(), member.id, hashToken(changeToken)]
    );
    const remove = (
      agent = member.agent,
      currentPassword = password,
      confirmation = '탈퇴'
    ) =>
      mutate(agent.post('/v1/auth/account-deletion')).send({
        currentPassword,
        confirmation,
      });
    await t.test(
      'preflight ownership, authentication, CSRF and password/confirmation boundaries',
      async () => {
        await api.get('/v1/auth/account-deletion').expect(401);
        await mutate(api.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(401);
        await member.agent
          .post('/v1/auth/account-deletion')
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(403);
        await remove(member.agent, password, '삭제').expect(400);
        await remove(member.agent, 'wrong-password-2026').expect(400);
        await mutate(member.agent.post('/v1/auth/account-deletion'))
          .send({
            currentPassword: password,
            confirmation: '탈퇴',
            userId: owner.id,
          })
          .expect(400);
        const blocked = await owner.agent
          .get('/v1/auth/account-deletion')
          .expect(200);
        assert.deepEqual(blocked.body, {
          ownedGroups: [{ id: groupId, name: '공유 유지' }],
          ownedGroupCount: 1,
          canDelete: false,
        });
        const result = await remove(owner.agent).expect(409);
        assert.equal(result.body.code, 'ACCOUNT_OWNS_GROUPS');
        await owner.agent.get('/v1/auth/me').expect(200);
        assert.equal(
          (await member.agent.get('/v1/auth/account-deletion')).body.canDelete,
          true
        );
      }
    );
    await t.test(
      'deletion clears every private record, rejects old sessions and retains READY files/comments/reactions',
      async () => {
        await remove().expect(204);
        await member.agent.get('/v1/auth/me').expect(401);
        await device.get('/v1/auth/me').expect(401);
        await owner.agent.get('/v1/auth/me').expect(200);
        await outsider.agent.get('/v1/auth/me').expect(200);
        await mutate(api.post('/v1/auth/login'))
          .send({ username: member.data.username, password })
          .expect(401);
        const user = (
          await admin.query('SELECT * FROM woori.users WHERE id=$1', [
            member.id,
          ])
        ).rows[0];
        assert.equal(user.status, 'DELETED');
        assert.equal(user.displayName, '탈퇴한 회원');
        assert.equal(user.passwordHash, '');
        assert.equal(user.verifiedAt, null);
        assert.notEqual(user.username, member.data.username);
        assert.notEqual(user.email, member.data.email);
        for (const table of [
          'sessions',
          'email_tokens',
          'push_installations',
          'notification_preferences',
          'group_notification_preferences',
          'photo_memory_preferences',
        ])
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int AS n FROM woori.${table} WHERE "userId"=$1`,
                [member.id]
              )
            ).rows[0].n,
            0,
            table
          );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int n FROM woori.notifications WHERE "recipientId"=$1',
              [member.id]
            )
          ).rows[0].n,
          0
        );
        assert.equal(
          (
            await admin.query(
              'SELECT status FROM woori.memberships WHERE "groupId"=$1 AND "userId"=$2',
              [groupId, member.id]
            )
          ).rows[0].status,
          'LEFT'
        );
        const ready = (
          await admin.query(
            'SELECT status,"deletedAt" FROM woori.photos WHERE id=$1',
            [photoId]
          )
        ).rows[0];
        assert.equal(ready.status, 'READY');
        assert.equal(ready.deletedAt, null);
        assert.equal(
          (
            await admin.query(
              'SELECT "usedBytes" FROM woori.groups WHERE id=$1',
              [groupId]
            )
          ).rows[0].usedBytes,
          '123'
        );
        const jobs = (
          await admin.query(
            'SELECT "photoId","objectKeys","availableAt" FROM woori.media_cleanup_jobs WHERE "photoId"=ANY($1::uuid[])',
            [[photoId, pendingId, processingId]]
          )
        ).rows;
        assert.equal(jobs.length, 2);
        assert.ok(
          jobs.every(
            (j) =>
              j.photoId !== photoId &&
              j.objectKeys.length === 1 &&
              j.availableAt > new Date()
          )
        );
        const photos = (
          await owner.agent
            .get(`/v1/groups/${groupId}/albums/${albumId}/photos`)
            .expect(200)
        ).body.photos;
        assert.ok(photos.some((p: { id: string }) => p.id === photoId));
        const comments = (
          await owner.agent.get(`/v1/photos/${photoId}/comments`).expect(200)
        ).body.comments;
        assert.equal(
          comments.find((c: { id: string }) => c.id === general.id).author
            .displayName,
          '탈퇴한 회원'
        );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int n FROM woori.reactions WHERE "photoId"=$1 AND "userId"=$2',
              [photoId, member.id]
            )
          ).rows[0].n,
          1
        );
        await assert.rejects(
          app
            .get(PhotosRepository)
            .content(groupId, albumId, photoId, member.id, 'ORIGINAL')
        );
      }
    );
    await t.test(
      'stale in-flight mutations cannot recreate sessions, groups, joins or modify shared content',
      async () => {
        await assert.rejects(
          app
            .get(PhotosRepository)
            .reserve(groupId, albumId, member.id, 'image/png', 123)
        );
        await assert.rejects(
          app
            .get(AuthRepository)
            .createSession(
              member.id,
              hashToken(createToken()),
              member.hash,
              member.data.email
            )
        );
        await assert.rejects(
          app.get(GroupsRepository).create('늦은 그룹', member.id)
        );
        await assert.rejects(
          app
            .get(InvitationsRepository)
            .join({ codeHash: hashInvitation(invitation.code) }, member.id)
        );
        await assert.rejects(
          app
            .get(GroupManagementRepository)
            .transfer(groupId, owner.id, member.id)
        );
        await assert.rejects(
          app
            .get(PhotoInteractionsRepository)
            .createComment(photoId, member.id, {
              body: '늦은 댓글',
              kind: 'GENERAL',
            })
        );
        await assert.rejects(
          app
            .get(MemoriesRepository)
            .captureDate(
              groupId,
              albumId,
              photoId,
              member.id,
              new Date('2020-01-01')
            )
        );
      }
    );
    await t.test(
      'same username and email create a distinct account without old memberships/content access',
      async () => {
        const rejoined = request.agent(app.getHttpServer());
        const result = await mutate(rejoined.post('/v1/auth/signup'))
          .send(member.data)
          .expect(201);
        assert.notEqual(result.body.user.id, member.id);
        await mutate(rejoined.post('/v1/auth/email-change/confirm'))
          .send({ token: changeToken })
          .expect(400);
        await admin.query(
          'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
          [result.body.user.id]
        );
        assert.deepEqual(
          (await rejoined.get('/v1/groups').expect(200)).body.groups,
          []
        );
        await rejoined.get(`/v1/photos/${photoId}/comments`).expect(404);
        await rejoined
          .get(`/v1/groups/${groupId}/albums/${albumId}/photos`)
          .expect(404);
      }
    );
    await t.test(
      'a deleting group no longer prevents withdrawal and remains scheduled for group cleanup',
      async () => {
        const account = await signup('d_deleting');
        const g = (
          await mutate(account.agent.post('/v1/groups'))
            .send({ name: '삭제 접수' })
            .expect(201)
        ).body.group.id;
        await mutate(account.agent.delete(`/v1/groups/${g}`))
          .send({ name: '삭제 접수' })
          .expect(202);
        await remove(account.agent).expect(204);
        assert.equal(
          (
            await admin.query('SELECT status FROM woori.groups WHERE id=$1', [
              g,
            ])
          ).rows[0].status,
          'DELETING'
        );
      }
    );
    await t.test(
      'new invitation join racing deletion cannot resurrect a membership',
      async () => {
        const a = await signup('d_racejoin');
        const results = await Promise.allSettled([
          app
            .get(AccountDeletionRepository)
            .delete(a.id, a.sessionHash, a.hash),
          app
            .get(InvitationsRepository)
            .join({ codeHash: hashInvitation(invitation.code) }, a.id),
        ]);
        expectedRace(results);
        assert.equal(
          (
            await admin.query('SELECT status FROM woori.users WHERE id=$1', [
              a.id,
            ])
          ).rows[0].status,
          'DELETED'
        );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int n FROM woori.memberships WHERE "userId"=$1 AND status=\'ACTIVE\'',
              [a.id]
            )
          ).rows[0].n,
          0
        );
      }
    );
    await t.test(
      'push registration and outbox fanout race deletion without retaining private FK rows',
      async () => {
        const a = await signup('d_racepush');
        await mutate(a.agent.post('/v1/invitations/join'))
          .send({ code: invitation.code })
          .expect(200);
        const photo = randomUUID();
        await admin.query(
          'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES($1,$2,$3,$4,\'READY\',1,1,1)',
          [photo, groupId, albumId, a.id]
        );
        const push = app.get(PushRepository);
        await push.register(
          a.id,
          a.sessionHash,
          hashToken(createToken()),
          'opaque-fixture',
          null
        );
        const dispatcher = new PushDispatchRepository(app.get(PrismaService));
        while (await dispatcher.fanOutOne()) {
          /* drain earlier fixtures without sending */
        }
        await app
          .get(PhotoInteractionsRepository)
          .createComment(photo, owner.id, {
            body: '삭제 경합 알림',
            kind: 'GENERAL',
          });
        const results = await Promise.allSettled([
          app
            .get(AccountDeletionRepository)
            .delete(a.id, a.sessionHash, a.hash),
          push.register(
            a.id,
            a.sessionHash,
            hashToken(createToken()),
            'opaque-new-fixture',
            null
          ),
          dispatcher.fanOutOne(),
        ]);
        expectedRace(results);
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[2].status, 'fulfilled');
        for (const table of ['sessions', 'push_installations'])
          assert.equal(
            (
              await admin.query(
                `SELECT count(*)::int n FROM woori.${table} WHERE "userId"=$1`,
                [a.id]
              )
            ).rows[0].n,
            0
          );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int n FROM woori.notifications WHERE "recipientId"=$1',
              [a.id]
            )
          ).rows[0].n,
          0
        );
      }
    );
    await t.test(
      'group creation and ownership transfer racing withdrawal cannot leave deleted active owners',
      async () => {
        const a = await signup('d_racecreate');
        const deletion = app.get(AccountDeletionRepository);
        const results = await Promise.allSettled([
          deletion.delete(a.id, a.sessionHash, a.hash),
          app.get(GroupsRepository).create('경합 그룹', a.id),
        ]);
        expectedRace(results);
        const state = (
          await admin.query(
            'SELECT u.status,(SELECT count(*)::int FROM woori.groups WHERE "ownerId"=u.id AND status=\'ACTIVE\') owned FROM woori.users u WHERE u.id=$1',
            [a.id]
          )
        ).rows[0];
        assert.ok(state.status === 'ACTIVE' || state.owned === 0);
        const b = await signup('d_racetransfer');
        await mutate(b.agent.post('/v1/invitations/join'))
          .send({ code: invitation.code })
          .expect(200);
        const transfer = await Promise.allSettled([
          deletion.delete(b.id, b.sessionHash, b.hash),
          app.get(GroupManagementRepository).transfer(groupId, owner.id, b.id),
        ]);
        expectedRace(transfer);
        const outcome = (
          await admin.query(
            'SELECT u.status,g."ownerId" FROM woori.users u CROSS JOIN woori.groups g WHERE u.id=$1 AND g.id=$2',
            [b.id, groupId]
          )
        ).rows[0];
        assert.ok(outcome.status === 'ACTIVE' || outcome.ownerId !== b.id);
      }
    );
  } finally {
    // The runner shares one isolated DB across suites. Remove only this suite's
    // synthetic queue fixtures, after asserting their durable deletion contract,
    // so an unrelated worker test cannot claim them as its own jobs.
    await admin.query(
      'DELETE FROM woori.media_cleanup_jobs WHERE "photoId"=ANY($1::uuid[])',
      [fixtureCleanupPhotoIds]
    );
    await app.close();
    await admin.end();
  }
});
