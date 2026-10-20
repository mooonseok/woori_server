import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request, { type Test } from 'supertest';
import { BadRequestException } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { StorageCleanupRepository } from '../src/worker/storage-cleanup/storage-cleanup.repository';
import { StorageCleanupService } from '../src/worker/storage-cleanup/storage-cleanup.service';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Agent = ReturnType<typeof request.agent>;
// supertest buffers unknown binary types; read the raw bytes either way.
const bytes = (response: request.Response) =>
  Buffer.isBuffer(response.body)
    ? response.body.toString()
    : String(response.text);

test('isolated PostgreSQL: profile photos stay personal, show only inside shared groups and are cleaned up', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  const password = 'avatar-integration-password-2026';
  try {
    await app.listen(0, '127.0.0.1');
    const signup = async (label: string, verified = true) => {
      const agent = request.agent(app.getHttpServer());
      const result = await mutate(agent.post('/v1/auth/signup'))
        .send({
          username: `${label}_${suffix}`,
          displayName: label,
          email: `${label}_${suffix}@example.test`,
          password,
        })
        .expect(201);
      if (verified)
        await admin.query(
          'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
          [result.body.user.id]
        );
      return { agent, id: result.body.user.id as string };
    };
    const owner = await signup('av_owner'),
      member = await signup('av_member'),
      outsider = await signup('av_out'),
      unverified = await signup('av_unv', false);
    // Give this suite's four signups back to the shared per-IP budget.
    await admin.query(
      'UPDATE woori.rate_limit_buckets SET attempts=GREATEST(attempts-4,0) WHERE id=ANY($1)',
      [
        ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
          (ip) =>
            rateLimitKey('auth', `signup-ip:${ip}`, new Date(), 60 * 60_000).id
        ),
      ]
    );
    const groupId = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '사진 확인' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ expiresInHours: 72, maxUses: 10 })
        .expect(201)
    ).body;
    await mutate(member.agent.post('/v1/invitations/join'))
      .send({ code: invitation.code })
      .expect(200);

    const storage = app.get(MediaStorageService);
    const processed: string[][] = [];
    const cleaned: string[][] = [];
    const removed: { userId: string; keys: string[] }[] = [];
    let failProcess = false;
    let failRemove = false;
    Object.assign(storage, {
      enabled: () => true,
      presign: async (_key: string, contentType: string) => ({
        uploadUrl: 'https://upload.example.test/avatar',
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + 600_000),
      }),
      processAvatar: async (
        _staging: string,
        _mime: string,
        _bytes: number,
        folder: string
      ) => {
        if (failProcess)
          throw new BadRequestException({ code: 'INVALID_PHOTO_FILE' });
        const keys = [`${folder}/512.webp`, `${folder}/128.webp`];
        processed.push(keys);
        return keys;
      },
      readAvatar: async (key: string) => ({
        data: Buffer.from(`webp:${key}`),
        contentType: 'image/webp',
      }),
      cleanup: async (keys: string[]) => {
        cleaned.push(keys);
      },
      removeAvatarObjects: async (userId: string, keys: string[]) => {
        if (failRemove) throw new Error('provider unavailable');
        removed.push({ userId, keys });
      },
    });
    const worker = new StorageCleanupService(
      new StorageCleanupRepository(app.get(PrismaService)),
      storage
    );
    const upload = async (agent: Agent) =>
      (
        await mutate(agent.post('/v1/auth/profile/avatar/uploads'))
          .send({ contentType: 'image/jpeg', bytes: 1000 })
          .expect(201)
      ).body;
    const complete = (agent: Agent, uploadId: string) =>
      mutate(agent.post('/v1/auth/profile/avatar/complete')).send({
        uploadId,
      });
    const avatar = (agent: Agent, userId: string, query = '') =>
      agent.get(`/v1/users/${userId}/avatar${query}`).buffer(true);
    const memberRow = async (agent: Agent, userId: string) =>
      (
        await agent.get(`/v1/groups/${groupId}/members`).expect(200)
      ).body.members.find((m: { userId: string }) => m.userId === userId);
    const dueJobs = async (userId: string) =>
      (
        await admin.query(
          'SELECT "objectKeys" FROM woori.storage_cleanup_jobs WHERE "userId"=$1 AND "completedAt" IS NULL AND "availableAt"<=now() ORDER BY "createdAt"',
          [userId]
        )
      ).rows.map((row: { objectKeys: string[] }) => row.objectKeys);

    await t.test(
      'requests need a confirmed email, the request headers and a bounded image',
      async () => {
        await mutate(unverified.agent.post('/v1/auth/profile/avatar/uploads'))
          .send({ contentType: 'image/jpeg', bytes: 1000 })
          .expect(403);
        await owner.agent
          .post('/v1/auth/profile/avatar/uploads')
          .send({ contentType: 'image/jpeg', bytes: 1000 })
          .expect(403);
        for (const body of [
          { contentType: 'image/heic', bytes: 1000 },
          { contentType: 'image/jpeg', bytes: 10 * 1024 * 1024 + 1 },
          { contentType: 'image/jpeg', bytes: 1000, extra: true },
        ])
          await mutate(owner.agent.post('/v1/auth/profile/avatar/uploads'))
            .send(body)
            .expect(400);
        const me = await owner.agent.get('/v1/auth/me').expect(200);
        assert.equal(me.body.user.avatarVersion, null);
      }
    );

    let firstFolder = '';
    await t.test(
      'an upload becomes the current photo exactly once, for its owner only',
      async () => {
        const ticket = await upload(owner.agent);
        assert.match(ticket.uploadId, UUID);
        assert.equal(ticket.headers['Content-Type'], 'image/jpeg');
        await complete(member.agent, ticket.uploadId).expect(404);
        const done = await complete(owner.agent, ticket.uploadId).expect(200);
        assert.equal(done.body.user.avatarVersion, 1);
        assert.equal('avatarKey' in done.body.user, false);
        await complete(owner.agent, ticket.uploadId).expect(404);
        assert.equal(
          (await owner.agent.get('/v1/auth/me').expect(200)).body.user
            .avatarVersion,
          1
        );
        firstFolder = processed[0][0].replace(/\/512\.webp$/, '');
        assert.match(
          firstFolder,
          new RegExp(`^avatars/${owner.id}/[0-9a-f-]{36}$`)
        );
        assert.deepEqual(cleaned.at(-1), [`staging/${ticket.uploadId}`]);
        // Its staging object and the orphan guard are scheduled, nothing is due.
        assert.deepEqual(await dueJobs(owner.id), []);
      }
    );

    await t.test(
      'only the owner and members of a shared active group can see it',
      async () => {
        const own = await avatar(owner.agent, owner.id, '?size=512&v=1').expect(
          200
        );
        assert.equal(own.headers['content-type'], 'image/webp');
        assert.equal(own.headers['cache-control'], 'private, max-age=86400');
        assert.equal(own.headers['vary'], 'Cookie');
        assert.equal(own.headers['x-content-type-options'], 'nosniff');
        assert.equal(bytes(own), `webp:${firstFolder}/512.webp`);
        const seen = await avatar(member.agent, owner.id).expect(200);
        assert.equal(bytes(seen), `webp:${firstFolder}/128.webp`);
        await avatar(outsider.agent, owner.id).expect(404);
        await avatar(member.agent, outsider.id).expect(404);
        await request(app.getHttpServer())
          .get(`/v1/users/${owner.id}/avatar`)
          .expect(401);
        await avatar(member.agent, owner.id, '?size=256').expect(400);
        await avatar(member.agent, 'not-a-uuid').expect(400);
        assert.equal(
          (await memberRow(member.agent, owner.id)).avatarVersion,
          1
        );
        assert.equal(
          (await memberRow(owner.agent, member.id)).avatarVersion,
          null
        );
        // A personal block hides the photo from the blocker only.
        await mutate(member.agent.put(`/v1/blocks/${owner.id}`))
          .send({})
          .expect(200);
        await avatar(member.agent, owner.id).expect(404);
        assert.equal(
          (await memberRow(member.agent, owner.id)).avatarVersion,
          null
        );
        await mutate(member.agent.delete(`/v1/blocks/${owner.id}`)).expect(204);
        await avatar(member.agent, owner.id).expect(200);
      }
    );

    await t.test(
      'replacing schedules the previous renditions for durable removal',
      async () => {
        const ticket = await upload(owner.agent);
        const done = await complete(owner.agent, ticket.uploadId).expect(200);
        assert.equal(done.body.user.avatarVersion, 2);
        const previous = [`${firstFolder}/512.webp`, `${firstFolder}/128.webp`];
        assert.deepEqual(await dueJobs(owner.id), [previous]);
        failRemove = true;
        assert.deepEqual(await worker.runBatch(), {
          completed: 0,
          retried: 1,
          purged: 0,
        });
        // Backed off: no longer due, kept for a later pass.
        assert.deepEqual(await dueJobs(owner.id), []);
        failRemove = false;
        await admin.query(
          'UPDATE woori.storage_cleanup_jobs SET "availableAt"=now() WHERE "userId"=$1 AND "completedAt" IS NULL AND "objectKeys"=$2',
          [owner.id, previous]
        );
        assert.equal((await worker.runBatch()).completed, 1);
        assert.deepEqual(removed.at(-1), { userId: owner.id, keys: previous });
        assert.deepEqual(await dueJobs(owner.id), []);
      }
    );

    await t.test(
      'an unreadable image is rejected without changing the photo',
      async () => {
        failProcess = true;
        const ticket = await upload(owner.agent);
        const rejected = await complete(owner.agent, ticket.uploadId).expect(
          400
        );
        assert.equal(rejected.body.code, 'INVALID_AVATAR_FILE');
        failProcess = false;
        assert.equal(
          (await owner.agent.get('/v1/auth/me').expect(200)).body.user
            .avatarVersion,
          2
        );
        // The unused folder keeps its delayed guard job (not yet due).
        assert.deepEqual(await dueJobs(owner.id), []);
        const guards = await admin.query(
          `SELECT count(*)::int AS n FROM woori.storage_cleanup_jobs WHERE "userId"=$1 AND "completedAt" IS NULL AND "objectKeys"[1] LIKE 'avatars/%'`,
          [owner.id]
        );
        assert.equal(guards.rows[0].n, 1);
      }
    );

    await t.test(
      'removal and account deletion clear the photo and schedule its objects',
      async () => {
        const current = (
          await admin.query('SELECT "avatarKey" FROM woori.users WHERE id=$1', [
            owner.id,
          ])
        ).rows[0].avatarKey as string;
        const cleared = await mutate(
          owner.agent.delete('/v1/auth/profile/avatar')
        ).expect(200);
        assert.equal(cleared.body.user.avatarVersion, null);
        await avatar(member.agent, owner.id).expect(404);
        assert.deepEqual(await dueJobs(owner.id), [
          [`${current}/512.webp`, `${current}/128.webp`],
        ]);
        // Idempotent: nothing more is scheduled.
        await mutate(owner.agent.delete('/v1/auth/profile/avatar')).expect(200);
        assert.equal((await dueJobs(owner.id)).length, 1);

        const ticket = await upload(member.agent);
        await complete(member.agent, ticket.uploadId).expect(200);
        await mutate(member.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        const row = await admin.query(
          'SELECT "avatarKey" FROM woori.users WHERE id=$1',
          [member.id]
        );
        assert.equal(row.rows[0].avatarKey, null);
        assert.equal((await dueJobs(member.id)).length, 1);
        assert.match((await dueJobs(member.id))[0][0], /^avatars\//);
        const uploads = await admin.query(
          'SELECT count(*)::int AS n FROM woori.avatar_uploads WHERE "userId"=$1',
          [member.id]
        );
        assert.equal(uploads.rows[0].n, 0);
      }
    );

    await t.test(
      'the runtime role has only the avatar table privileges it needs',
      async () => {
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const result = await runtime.query(
            `SELECT
            has_table_privilege(current_user, 'woori.avatar_uploads', 'DELETE') AS uploads_delete,
            has_table_privilege(current_user, 'woori.avatar_uploads', 'TRUNCATE') AS uploads_truncate,
            (has_table_privilege(current_user, 'woori.storage_cleanup_jobs', 'SELECT') AND has_table_privilege(current_user, 'woori.storage_cleanup_jobs', 'INSERT') AND has_table_privilege(current_user, 'woori.storage_cleanup_jobs', 'UPDATE')) AS jobs_write,
            has_table_privilege(current_user, 'woori.storage_cleanup_jobs', 'DELETE') AS jobs_delete,
            has_table_privilege(current_user, 'woori.storage_cleanup_jobs', 'TRUNCATE') AS jobs_truncate`
          );
          assert.deepEqual(result.rows[0], {
            uploads_delete: true,
            uploads_truncate: false,
            jobs_write: true,
            jobs_delete: false,
            jobs_truncate: false,
          });
        } finally {
          await runtime.end();
        }
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
