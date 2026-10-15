import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request, { type Test } from 'supertest';
import { BadRequestException } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import {
  MediaStorageService,
  type MediaVariant,
} from '../src/common/media/media-storage.service';
import { PhotoProcessingService } from '../src/worker/photo-processing/photo-processing.service';
function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
const variants = (prefix: string): MediaVariant[] =>
  (['ORIGINAL', 'DISPLAY', 'THUMBNAIL'] as const).map((kind) => ({
    kind,
    objectKey: `${prefix}/${kind === 'ORIGINAL' ? 'original.jpg' : kind === 'DISPLAY' ? 'display.webp' : 'thumbnail.webp'}`,
    mime: kind === 'ORIGINAL' ? 'image/jpeg' : 'image/webp',
    width: 2,
    height: 2,
    bytes: 1,
  }));

test('isolated PostgreSQL: durable photo jobs preserve authorization, quota and publication fencing', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  try {
    await app.listen(0, '127.0.0.1');
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const result = await mutate(agent.post('/v1/auth/signup'))
        .send({
          username: `${label}_${suffix}`,
          displayName: label,
          email: `${label}_${suffix}@example.test`,
          password: 'photo-queue-integration-password-2026',
        })
        .expect(201);
      await admin.query(
        'UPDATE woori.users SET "verifiedAt"=now() WHERE id=$1',
        [result.body.user.id]
      );
      return { agent, id: result.body.user.id as string };
    };
    const owner = await signup('q_owner'),
      member = await signup('q_member'),
      outsider = await signup('q_outside');
    const g = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '처리 검증' })
        .expect(201)
    ).body.group.id;
    const inv = (
      await mutate(owner.agent.post(`/v1/groups/${g}/invitations`))
        .send({ expiresInHours: 72, maxUses: 10 })
        .expect(201)
    ).body;
    await mutate(member.agent.post('/v1/invitations/join'))
      .send({ code: inv.code })
      .expect(200);
    const a = (
      await mutate(owner.agent.post(`/v1/groups/${g}/albums`))
        .send({ title: '처리 사진' })
        .expect(201)
    ).body.album.id;
    const base = `/v1/groups/${g}/albums/${a}`;
    const repo = app.get(PhotosRepository),
      storage = app.get(MediaStorageService),
      worker = new PhotoProcessingService(repo, storage);
    const cleaned: string[][] = [];
    let calls = 0;
    const processOk = async (
      _key: string,
      _mime: string,
      _bytes: number,
      prefix: string
    ) => {
      calls++;
      return variants(prefix);
    };
    Object.assign(storage, {
      enabled: () => true,
      presign: async () => ({
        uploadUrl: 'https://upload.example.test/file',
        headers: { 'Content-Type': 'image/jpeg' },
        expiresAt: new Date(Date.now() + 600_000),
      }),
      process: processOk,
      cleanup: async (keys: string[]) => {
        cleaned.push(keys);
      },
    });
    const upload = async () =>
      (
        await mutate(owner.agent.post(`${base}/uploads`))
          .send({ filename: 'test.jpg', contentType: 'image/jpeg', bytes: 1 })
          .expect(201)
      ).body.photoId as string;
    const enqueue = (id: string) =>
      mutate(owner.agent.post(`${base}/photos/${id}/process`)).send({});
    const state = async (id: string) =>
      (await owner.agent.get(`${base}/photos/${id}/processing`).expect(200))
        .body;
    const raw = async (id: string) =>
      (await admin.query('SELECT * FROM woori.photos WHERE id=$1', [id]))
        .rows[0];
    const later = async (id: string) =>
      admin.query(
        'UPDATE woori.photos SET "processingAvailableAt"=now()-interval \'1 second\' WHERE id=$1',
        [id]
      );
    let readyId = '';
    await t.test(
      'additive API guards own uploads and idempotently enqueues, keeps legacy complete isolated',
      async () => {
        readyId = await upload();
        await owner.agent
          .get(`${base}/photos/${readyId}/processing`)
          .expect(404);
        await mutate(member.agent.post(`${base}/photos/${readyId}/process`))
          .send({})
          .expect(404);
        await mutate(outsider.agent.post(`${base}/photos/${readyId}/process`))
          .send({})
          .expect(404);
        await enqueue(readyId).send({ userId: member.id }).expect(400);
        const receipts = await Promise.all([
          enqueue(readyId).expect(202),
          enqueue(readyId).expect(202),
        ]);
        assert.ok(receipts.every((r) => r.body.phase === 'QUEUED'));
        assert.equal(calls, 0);
        await mutate(
          owner.agent.post(`${base}/photos/${readyId}/complete`)
        ).expect(409);
        await member.agent
          .get(`${base}/photos/${readyId}/processing`)
          .expect(404);
        assert.deepEqual(
          (await member.agent.get(`${base}/uploads`).expect(200)).body.uploads,
          []
        );
        const jobs = (
          await owner.agent.get(`${base}/uploads?activeOnly=true`).expect(200)
        ).body;
        assert.equal(jobs.uploads[0].photoId, readyId);
        assert.equal(JSON.stringify(jobs).includes('staging/'), false);
        await admin.query(
          'UPDATE woori.photos SET "uploadExpiresAt"=now()-interval \'1 hour\' WHERE id=$1',
          [readyId]
        );
        assert.deepEqual(await worker.runBatch(1), {
          completed: 1,
          retried: 0,
        });
        assert.equal((await state(readyId)).phase, 'READY');
        assert.equal(
          (await enqueue(readyId).expect(202)).body.photo.id,
          readyId
        );
        assert.equal(
          (
            await mutate(
              owner.agent.post(`${base}/photos/${readyId}/complete`)
            ).expect(200)
          ).body.photo.id,
          readyId
        );
        assert.equal(calls, 1);
        assert.equal(
          (
            await admin.query(
              'SELECT "usedBytes" FROM woori.groups WHERE id=$1',
              [g]
            )
          ).rows[0].usedBytes,
          '3'
        );
      }
    );
    await t.test(
      'queued reservations remain counted after PUT expiry; paging and filters remain bounded',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        await admin.query(
          'UPDATE woori.photos SET "uploadExpiresAt"=now()-interval \'1 hour\' WHERE id=$1',
          [id]
        );
        await admin.query(
          'UPDATE woori.groups SET "quotaBytes"=$2 WHERE id=$1',
          [g, (90 * 1024 * 1024 + 3).toString()]
        );
        const denied = await mutate(owner.agent.post(`${base}/uploads`))
          .send({ filename: 'test.jpg', contentType: 'image/jpeg', bytes: 1 })
          .expect(409);
        assert.equal(denied.body.code, 'STORAGE_QUOTA_EXCEEDED');
        await admin.query(
          'UPDATE woori.groups SET "quotaBytes"=21474836480 WHERE id=$1',
          [g]
        );
        const page = (
          await owner.agent.get(`${base}/uploads?limit=1`).expect(200)
        ).body;
        assert.equal(page.uploads[0].photoId, id);
        assert.equal(page.nextCursor, id);
        assert.equal(
          (
            await owner.agent
              .get(`${base}/uploads?limit=1&cursor=${id}`)
              .expect(200)
          ).body.uploads[0].photoId,
          readyId
        );
        await owner.agent.get(`${base}/uploads?activeOnly=invalid`).expect(400);
        await worker.runBatch(1);
      }
    );
    await t.test(
      'worker recreation and expired lease resume; stale attempt cannot publish or fail newer lease',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        const first = await repo.claimQueued();
        assert.equal(first!.photo.id, id);
        await admin.query(
          'UPDATE woori.photos SET "processingUntil"=now()-interval \'1 second\' WHERE id=$1',
          [id]
        );
        const second = await new PhotosRepository(
          app.get(PrismaService)
        ).claimQueued();
        assert.equal(second!.photo.id, id);
        assert.notEqual(first!.token, second!.token);
        await assert.rejects(
          repo.finish(
            g,
            a,
            id,
            owner.id,
            first!.token,
            variants(`photos/${id}/${first!.token}`)
          )
        );
        assert.equal(await repo.failQueued(id, first!.token, true), false);
        await repo.finish(
          g,
          a,
          id,
          owner.id,
          second!.token,
          variants(`photos/${id}/${second!.token}`)
        );
        assert.equal((await raw(id)).processingAttempts, 2);
      }
    );
    await t.test(
      'transient errors retry five times, invalid files fail immediately and release reservation',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        storage.process = async () => {
          throw new Error('private storage provider message');
        };
        for (let i = 1; i <= 5; i++) {
          await later(id);
          await worker.runBatch(1);
          const row = await raw(id);
          assert.equal(row.processingAttempts, i);
          assert.equal(row.status, i === 5 ? 'FAILED' : 'PROCESSING');
        }
        assert.equal((await raw(id)).reservedBytes, '0');
        assert.equal((await state(id)).errorCode, 'PHOTO_PROCESSING_FAILED');
        const invalid = await upload();
        await enqueue(invalid).expect(202);
        storage.process = async () => {
          throw new BadRequestException({ code: 'INVALID_PHOTO_FILE' });
        };
        await worker.runBatch(1);
        assert.equal((await state(invalid)).errorCode, 'INVALID_PHOTO_FILE');
        assert.equal((await raw(invalid)).processingAttempts, 1);
        storage.process = processOk;
      }
    );
    await t.test(
      'membership revocation and deadline terminally stop queued jobs',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        await admin.query(
          'UPDATE woori.memberships SET status=\'LEFT\' WHERE "groupId"=$1 AND "userId"=$2',
          [g, owner.id]
        );
        await owner.agent.get(`${base}/photos/${id}/processing`).expect(404);
        await worker.runBatch(1);
        assert.equal(
          (await raw(id)).processingErrorCode,
          'UPLOAD_ACCESS_REVOKED'
        );
        assert.equal((await raw(id)).reservedBytes, '0');
        await admin.query(
          'UPDATE woori.memberships SET status=\'ACTIVE\' WHERE "groupId"=$1 AND "userId"=$2',
          [g, owner.id]
        );
        const expired = await upload();
        await enqueue(expired).expect(202);
        await admin.query(
          'UPDATE woori.photos SET "processingDeadlineAt"=now()-interval \'1 second\' WHERE id=$1',
          [expired]
        );
        await worker.runBatch(1);
        assert.equal((await state(expired)).errorCode, 'UPLOAD_EXPIRED');
      }
    );
    await t.test(
      'deleted in-flight photo cannot publish; late exact keys reopen durable cleanup',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        storage.process = async (...args) => {
          await mutate(owner.agent.delete(`${base}/photos/${id}`)).expect(204);
          return processOk(...args);
        };
        await worker.runBatch(1);
        assert.equal((await raw(id)).status, 'DELETING');
        assert.equal(
          (
            await admin.query(
              'SELECT "objectKeys" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
              [id]
            )
          ).rows[0].objectKeys.length,
          4
        );
        await owner.agent.get(`${base}/photos/${id}/processing`).expect(404);
        storage.process = processOk;
      }
    );
    await t.test(
      'lost successful commit response never cleans published variants',
      async () => {
        const id = await upload();
        await enqueue(id).expect(202);
        const finish = repo.finish.bind(repo);
        const before = cleaned.length;
        repo.finish = async (...args) => {
          await finish(...args);
          throw new Error('lost DB commit response');
        };
        try {
          await worker.runBatch(1);
        } finally {
          repo.finish = finish;
        }
        assert.equal((await state(id)).phase, 'READY');
        assert.equal(cleaned.length, before);
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
