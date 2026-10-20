import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import { GroupCleanupRepository } from '../src/worker/group-cleanup/group-cleanup.repository';
import { GroupCleanupService } from '../src/worker/group-cleanup/group-cleanup.service';
import { MediaCleanupRepository } from '../src/worker/media-cleanup/media-cleanup.repository';
import { MediaCleanupService } from '../src/worker/media-cleanup/media-cleanup.service';
import { MediaStorageService } from '../src/common/media/media-storage.service';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
test('isolated PostgreSQL: group lifecycle, content retention and durable deletion', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const origin = process.env.WEB_ORIGIN!;
  const mutate = (op: Test) =>
    op.set('Origin', origin).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const result = await mutate(agent.post('/v1/auth/signup'))
        .send({
          username: `${label}_${suffix}`,
          displayName: label,
          nickname: label,
          email: `${label}_${suffix}@example.test`,
          password: 'group-integration-password-2026',
        })
        .expect(201);
      await admin.query(
        'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
        [result.body.user.id]
      );
      return { agent, id: result.body.user.id as string };
    };
    const owner = await signup('g_owner'),
      a = await signup('g_a'),
      b = await signup('g_b');
    const create = async (name: string) =>
      (await mutate(owner.agent.post('/v1/groups')).send({ name }).expect(201))
        .body.group.id as string;
    const invite = async (groupId: string) =>
      (
        await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
          .send({ expiresInHours: 72, maxUses: 10 })
          .expect(201)
      ).body;
    const join = async (member: typeof a, code: string) =>
      mutate(member.agent.post('/v1/invitations/join'))
        .send({ code })
        .expect(200);
    const g = await create('권한 검증 그룹'),
      invitation = await invite(g);
    await join(a, invitation.code);
    const album = (
      await mutate(a.agent.post(`/v1/groups/${g}/albums`))
        .send({ title: '공유 사진' })
        .expect(201)
    ).body.album.id as string;
    const photoId = randomUUID();
    await admin.query(
      'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) VALUES($1,$2,$3,$4,\'READY\',123,1,1)',
      [photoId, g, album, a.id]
    );
    await admin.query('UPDATE woori.groups SET "usedBytes"=123 WHERE id=$1', [
      g,
    ]);
    const comment = (
      await mutate(a.agent.post(`/v1/photos/${photoId}/comments`))
        .send({ body: '떠난 뒤에도 남는 댓글', kind: 'GENERAL' })
        .expect(201)
    ).body.comment;
    await mutate(a.agent.put(`/v1/photos/${photoId}/reactions`))
      .send({ emoji: '❤️' })
      .expect(200);
    await mutate(owner.agent.post(`/v1/photos/${photoId}/comments`))
      .send({ body: '알림 대상', kind: 'GENERAL' })
      .expect(201);
    const notification = (
      await a.agent.get('/v1/notifications').expect(200)
    ).body.notifications.find((n: { groupId: string }) => n.groupId === g);
    await t.test(
      'member roster is scoped and paginated, and only owner may rename/delete/transfer',
      async () => {
        await api.get(`/v1/groups/${g}/members`).expect(401);
        await b.agent.get(`/v1/groups/${g}/members`).expect(404);
        const first = (
          await a.agent.get(`/v1/groups/${g}/members?limit=1`).expect(200)
        ).body;
        assert.equal(first.members.length, 1);
        assert.ok(first.nextCursor);
        assert.deepEqual(Object.keys(first.members[0]).sort(), [
          'blockedByMe',
          'displayName',
          'joinedAt',
          'nickname',
          'role',
          'userId',
        ]);
        const second = (
          await a.agent
            .get(`/v1/groups/${g}/members?after=${first.nextCursor}&limit=1`)
            .expect(200)
        ).body;
        assert.equal(second.members.length, 1);
        assert.equal(second.nextCursor, null);
        assert.notEqual(first.members[0].userId, second.members[0].userId);
        await a.agent.get(`/v1/groups/${g}/members?limit=51`).expect(400);
        await mutate(a.agent.patch(`/v1/groups/${g}`))
          .send({ name: '권한 없음' })
          .expect(403);
        await mutate(a.agent.delete(`/v1/groups/${g}`))
          .send({ name: '권한 검증 그룹' })
          .expect(403);
        await mutate(b.agent.patch(`/v1/groups/${g}`))
          .send({ name: '외부' })
          .expect(404);
        await mutate(owner.agent.post(`/v1/groups/${g}/leave`)).expect(409);
        await mutate(owner.agent.patch(`/v1/groups/${g}`))
          .send({ name: '   ' })
          .expect(400);
        await mutate(owner.agent.patch(`/v1/groups/${g}`))
          .send({ name: '이름 변경', ownerId: a.id })
          .expect(400);
        await mutate(owner.agent.patch(`/v1/groups/${g}`))
          .send({ name: '이름 변경' })
          .expect(200);
        await mutate(owner.agent.delete(`/v1/groups/${g}`))
          .send({ name: '예전 이름' })
          .expect(409);
        await mutate(a.agent.patch(`/v1/groups/${g}/albums/${album}`))
          .send({ title: '생성자 수정 불가' })
          .expect(404);
      }
    );
    await t.test(
      'leave/remove deny all content access while retaining contributions; only LEFT can rejoin',
      async () => {
        await mutate(a.agent.post(`/v1/groups/${g}/leave`)).expect(204);
        for (const path of [
          `/v1/groups/${g}`,
          `/v1/groups/${g}/members`,
          `/v1/groups/${g}/albums`,
          `/v1/groups/${g}/albums/${album}/photos`,
          `/v1/groups/${g}/albums/${album}/photos/${photoId}/content`,
          `/v1/photos/${photoId}/comments`,
          `/v1/photos/${photoId}/reactions`,
          `/v1/notifications/${notification.id}/target`,
        ])
          await a.agent.get(path).expect(404);
        await mutate(a.agent.post(`/v1/photos/${photoId}/comments`))
          .send({ body: '접근 차단', kind: 'GENERAL' })
          .expect(404);
        await mutate(a.agent.put(`/v1/photos/${photoId}/reactions`))
          .send({ emoji: '❤️' })
          .expect(404);
        const retained = (
          await owner.agent.get(`/v1/photos/${photoId}/comments`).expect(200)
        ).body.comments;
        assert.ok(retained.some((c: { id: string }) => c.id === comment.id));
        assert.equal(
          (
            await admin.query(
              'SELECT status,bytes FROM woori.photos WHERE id=$1',
              [photoId]
            )
          ).rows[0].status,
          'READY'
        );
        assert.equal(
          (
            await a.agent.get('/v1/notifications').expect(200)
          ).body.notifications.some(
            (n: { id: string }) => n.id === notification.id
          ),
          false
        );
        await join(a, invitation.code);
        await mutate(
          owner.agent.delete(`/v1/groups/${g}/members/${a.id}`)
        ).expect(204);
        await mutate(
          owner.agent.delete(`/v1/groups/${g}/members/${a.id}`)
        ).expect(204);
        await mutate(a.agent.post('/v1/invitations/join'))
          .send({ code: invitation.code })
          .expect(403);
        await a.agent.get(`/v1/groups/${g}/albums`).expect(404);
        assert.equal(
          (
            await admin.query(
              'SELECT "deletedAt" FROM woori.comments WHERE id=$1',
              [comment.id]
            )
          ).rows[0].deletedAt,
          null
        );
      }
    );
    await t.test(
      'concurrent ownership transfers keep one owner and invalidate old invites',
      async () => {
        const group = await create('이전 경합'),
          inv = await invite(group);
        await join(a, inv.code);
        await join(b, inv.code);
        const results = await Promise.all(
          [a, b].map((target) =>
            mutate(owner.agent.post(`/v1/groups/${group}/ownership`)).send({
              userId: target.id,
            })
          )
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 403]);
        const actual = (
          await admin.query('SELECT "ownerId" FROM woori.groups WHERE id=$1', [
            group,
          ])
        ).rows[0].ownerId;
        const roles = (
          await admin.query(
            'SELECT "userId" FROM woori.memberships WHERE "groupId"=$1 AND role=\'OWNER\' AND status=\'ACTIVE\'',
            [group]
          )
        ).rows;
        assert.deepEqual(roles, [{ userId: actual }]);
        await mutate(owner.agent.patch(`/v1/groups/${group}`))
          .send({ name: '옛 그룹장' })
          .expect(403);
        await mutate(owner.agent.post('/v1/invitations/preview'))
          .send({ code: inv.code })
          .expect(410);
        const current = actual === a.id ? a : b,
          target = actual === a.id ? b : a;
        const race = await Promise.all([
          mutate(current.agent.post(`/v1/groups/${group}/ownership`)).send({
            userId: target.id,
          }),
          mutate(target.agent.post(`/v1/groups/${group}/leave`)),
        ]);
        assert.ok(
          (race[0].status === 200 && race[1].status === 409) ||
            (race[0].status === 409 && race[1].status === 204)
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM woori.memberships WHERE \"groupId\"=$1 AND role='OWNER' AND status='ACTIVE'",
              [group]
            )
          ).rows[0].n,
          1
        );
      }
    );
    await t.test(
      'deletion blocks an earlier upload claim and future joins immediately',
      async () => {
        const inv = await invite(g);
        const repo = app.get(PhotosRepository);
        const reserved = await repo.reserve(
          g,
          album,
          owner.id,
          'image/png',
          10
        );
        const claimed = await repo.claim(g, album, reserved.id, owner.id);
        assert.equal(claimed.ready, false);
        await mutate(owner.agent.delete(`/v1/groups/${g}`))
          .send({ name: '이름 변경' })
          .expect(202);
        await mutate(owner.agent.delete(`/v1/groups/${g}`))
          .send({ name: '이름 변경' })
          .expect(202);
        await owner.agent.get(`/v1/groups/${g}/members`).expect(404);
        await owner.agent.get(`/v1/photos/${photoId}/comments`).expect(404);
        await mutate(b.agent.post('/v1/invitations/join'))
          .send({ code: inv.code })
          .expect(410);
        await assert.rejects(
          repo.finish(g, album, reserved.id, owner.id, claimed.token!, [
            {
              kind: 'ORIGINAL',
              objectKey: `photos/${reserved.id}/attempt/original`,
              mime: 'image/png',
              bytes: 10,
              width: 1,
              height: 1,
            },
          ])
        );
        const sweep = new GroupCleanupService(
          new GroupCleanupRepository(app.get(PrismaService))
        );
        const result = await sweep.runBatch();
        assert.ok(result.photos >= 2);
        const job = (
          await admin.query(
            'SELECT "availableAt" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
            [reserved.id]
          )
        ).rows[0];
        assert.ok(
          new Date(job.availableAt).getTime() > Date.now() + 20 * 60_000
        );
        assert.equal(
          (
            await admin.query(
              'SELECT "reservedBytes" FROM woori.photos WHERE id=$1',
              [reserved.id]
            )
          ).rows[0].reservedBytes,
          '0'
        );
      }
    );
    await t.test(
      'bounded worker resumes, retries storage, finalizes once and reopens late cleanup',
      async () => {
        const group = await create('대량 삭제');
        const albumId = (
          await mutate(owner.agent.post(`/v1/groups/${group}/albums`))
            .send({ title: '대량 앨범' })
            .expect(201)
        ).body.album.id;
        await admin.query(
          'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) SELECT gen_random_uuid(),$1,$2,$3,\'READY\',1,1,1 FROM generate_series(1,205)',
          [group, albumId, owner.id]
        );
        await admin.query(
          'UPDATE woori.groups SET "usedBytes"=205 WHERE id=$1',
          [group]
        );
        await admin.query(
          'INSERT INTO woori.albums(id,"groupId","creatorId",title) SELECT gen_random_uuid(),$1,$2,\'빈 앨범\' FROM generate_series(1,104)',
          [group, owner.id]
        );
        await mutate(owner.agent.delete(`/v1/groups/${group}`))
          .send({ name: '대량 삭제' })
          .expect(202);
        const prisma = app.get(PrismaService),
          repo = new GroupCleanupRepository(prisma);
        const first = await repo.progress([g]);
        assert.equal(first?.photos, 100);
        assert.equal(first?.albums, 100);
        assert.equal(first?.completed, false);
        const restarted = new GroupCleanupRepository(prisma);
        const second = await restarted.progress([g]);
        assert.equal(second?.photos, 100);
        assert.equal(second?.albums, 5);
        const third = await restarted.progress([g]);
        assert.equal(third?.photos, 5);
        assert.equal(await restarted.progress([g]), null);
        assert.equal(
          (
            await admin.query(
              'SELECT "usedBytes",status FROM woori.groups WHERE id=$1',
              [group]
            )
          ).rows[0].usedBytes,
          '0'
        );
        let fail = true;
        const storage = {
          async removePhotoObjects() {
            if (fail) {
              fail = false;
              throw Error('fixture storage failure');
            }
          },
        } as unknown as MediaStorageService;
        const cleanup = new MediaCleanupService(
          new MediaCleanupRepository(prisma),
          storage
        );
        const failed = await cleanup.runBatch(1);
        assert.equal(failed.retried, 1);
        await admin.query(
          'UPDATE woori.media_cleanup_jobs SET "availableAt"=now()-interval \'1 second\' WHERE attempts>0 AND "completedAt" IS NULL'
        );
        for (let i = 0; i < 4; i++) await cleanup.runBatch(100);
        await new GroupCleanupService(restarted).runBatch();
        assert.equal(
          (
            await admin.query('SELECT status FROM woori.groups WHERE id=$1', [
              group,
            ])
          ).rows[0].status,
          'DELETED'
        );
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.media_cleanup_jobs j JOIN woori.photos p ON p.id=j."photoId" WHERE p."groupId"=$1',
              [group]
            )
          ).rows[0].n,
          205
        );
        const late = (
          await admin.query(
            'SELECT id FROM woori.photos WHERE "groupId"=$1 LIMIT 1',
            [group]
          )
        ).rows[0].id;
        await app
          .get(PhotosRepository)
          .queueDeletedAttempt(late, [`photos/${late}/late/original`]);
        assert.equal(
          (
            await admin.query('SELECT status FROM woori.groups WHERE id=$1', [
              group,
            ])
          ).rows[0].status,
          'DELETING'
        );
        await cleanup.runBatch();
        await new GroupCleanupService(restarted).runBatch();
        assert.equal(
          (
            await admin.query(
              'SELECT status,"usedBytes" FROM woori.groups WHERE id=$1',
              [group]
            )
          ).rows[0].status,
          'DELETED'
        );
      }
    );
    await t.test(
      'parallel deletion, upload publication and invitation join stay consistent',
      async () => {
        const group = await create('동시 삭제'),
          inv = await invite(group);
        const albumId = (
          await mutate(owner.agent.post(`/v1/groups/${group}/albums`))
            .send({ title: '동시 앨범' })
            .expect(201)
        ).body.album.id;
        const photos = app.get(PhotosRepository);
        const photo = await photos.reserve(
          group,
          albumId,
          owner.id,
          'image/png',
          10
        );
        const claim = await photos.claim(group, albumId, photo.id, owner.id);
        const results = await Promise.allSettled([
          mutate(owner.agent.delete(`/v1/groups/${group}`))
            .send({ name: '동시 삭제' })
            .expect(202),
          photos.finish(group, albumId, photo.id, owner.id, claim.token!, [
            {
              kind: 'ORIGINAL',
              objectKey: `photos/${photo.id}/attempt/original`,
              mime: 'image/png',
              bytes: 10,
              width: 1,
              height: 1,
            },
          ]),
          mutate(b.agent.post('/v1/invitations/join')).send({ code: inv.code }),
        ]);
        assert.equal(results[0].status, 'fulfilled');
        assert.equal(results[2].status, 'fulfilled');
        if (results[2].status === 'fulfilled')
          assert.ok(
            [200, 410].includes(results[2].value.status),
            JSON.stringify({
              status: results[2].value.status,
              body: results[2].value.body,
            })
          );
        if (results[1].status === 'rejected')
          assert.equal(results[1].reason.getStatus(), 404);
        await owner.agent
          .get(`/v1/groups/${group}/albums/${albumId}/photos`)
          .expect(404);
        await b.agent.get(`/v1/groups/${group}`).expect(404);
        await new GroupCleanupService(
          new GroupCleanupRepository(app.get(PrismaService))
        ).runBatch();
        const row = (
          await admin.query(
            'SELECT "usedBytes" FROM woori.groups WHERE id=$1',
            [group]
          )
        ).rows[0];
        assert.equal(row.usedBytes, '0');
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
              [photo.id]
            )
          ).rows[0].n,
          1
        );
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
