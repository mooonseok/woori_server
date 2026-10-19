import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { Express } from 'express';
import request from 'supertest';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  streamPrivateVideo,
  videoRange,
} from '../src/common/media/video-response';
import {
  createAdminVideoTicket,
  verifyAdminVideoTicket,
} from '../src/admin/admin-video-ticket';
import { MediaStorageService } from '../src/common/media/media-storage.service';

const config = {
  webOrigin: 'https://admin.example.test',
  totpEncryptionKey: randomBytes(32).toString('base64'),
};
const now = Date.now();
const session = {
  sessionId: randomUUID(),
  admin: { id: randomUUID(), username: 'operator', displayName: 'operator' },
  totpEnabled: true,
  mfaVerifiedAt: new Date(now),
  reauthAt: new Date(now),
  expiresAt: new Date(now + 3600_000),
  idleExpiresAt: new Date(now + 1800_000),
};

test('admin video grant needs server signature, exact live session, photo and expiry', () => {
  const photoId = randomUUID();
  const { ticket, expiresAt } = createAdminVideoTicket(
    config,
    session,
    photoId,
    randomUUID(),
    now
  );
  assert.equal(expiresAt.getTime(), now + 300_000);
  verifyAdminVideoTicket(config, session, photoId, ticket, now);
  for (const check of [
    () => verifyAdminVideoTicket(config, session, photoId, ticket + 'x', now),
    () =>
      verifyAdminVideoTicket(
        config,
        { ...session, sessionId: randomUUID() },
        photoId,
        ticket,
        now
      ),
    () =>
      verifyAdminVideoTicket(
        config,
        { ...session, admin: { ...session.admin, id: randomUUID() } },
        photoId,
        ticket,
        now
      ),
    () => verifyAdminVideoTicket(config, session, randomUUID(), ticket, now),
    () =>
      verifyAdminVideoTicket(config, session, photoId, ticket, now + 300_000),
    () =>
      verifyAdminVideoTicket(
        { ...config, totpEncryptionKey: randomBytes(32).toString('base64') },
        session,
        photoId,
        ticket,
        now
      ),
  ])
    assert.throws(check);
  assert.equal(
    createAdminVideoTicket(
      config,
      { ...session, reauthAt: new Date(now - 590_000) },
      photoId,
      randomUUID(),
      now
    ).expiresAt.getTime(),
    now + 10_000
  );
});

test('single video ranges accept bounded/open/suffix and reject ambiguous or unsatisfiable ranges', () => {
  assert.deepEqual(videoRange('bytes=0-0', 10), {
    start: 0,
    end: 0,
    length: 1,
  });
  assert.deepEqual(videoRange('bytes=8-', 10), { start: 8, end: 9, length: 2 });
  assert.deepEqual(videoRange('bytes=-3', 10), { start: 7, end: 9, length: 3 });
  assert.deepEqual(videoRange('bytes=0-99', 10), {
    start: 0,
    end: 9,
    length: 10,
  });
  for (const value of [
    'bytes=10-',
    'bytes=4-2',
    'bytes=-0',
    'bytes=',
    'bytes=0-1,3-4',
    'bytes=9007199254740992-',
    'items=0-1',
  ])
    assert.throws(() => videoRange(value, 10));
});

test('video streaming HEAD ignores Range; upstream failure stays JSON and connection close aborts', async () => {
  const app = new ExpressAdapter().getInstance() as Express;
  let opens = 0;
  app.get('/video', async (req, res) => {
    await streamPrivateVideo(req, res, {
      bytes: 4,
      open: async (range) => {
        opens++;
        return Readable.from([
          Buffer.from('abcd').subarray(
            range?.start ?? 0,
            range ? range.end + 1 : 4
          ),
        ]);
      },
    });
  });
  await request(app)
    .head('/video')
    .set('Range', 'bytes=99-')
    .expect(200)
    .expect('Content-Length', '4');
  assert.equal(opens, 0);
  await request(app)
    .get('/video')
    .set('Range', 'bytes=0-0')
    .expect(206)
    .expect('Content-Range', 'bytes 0-0/4');
  app.get('/fail', async (req, res) => {
    try {
      await streamPrivateVideo(
        req,
        res,
        {
          bytes: 4,
          open: async () => {
            throw new ServiceUnavailableException();
          },
        },
        true
      );
    } catch {
      res.status(503).json({ code: 'MEDIA_STORAGE_UNAVAILABLE' });
    }
  });
  const failed = await request(app).get('/fail').expect(503);
  assert.match(failed.headers['content-type'], /application\/json/);
  assert.equal(failed.headers['content-disposition'], undefined);
  let aborted!: () => void;
  const abortSeen = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  app.get('/slow', async (req, res) => {
    await streamPrivateVideo(req, res, {
      bytes: 100_000,
      open: async (_range, signal) => {
        const body = new Readable({
          read() {
            this.push(Buffer.alloc(1));
          },
        });
        signal.addEventListener('abort', () => aborted(), { once: true });
        return body;
      },
    });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${address.port}/slow`,
        (res) => {
          res.once('data', () => {
            res.destroy();
            resolve();
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
    await Promise.race([
      abortSeen,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream abort missing')), 1000)
      ),
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('R2 video stream sends Range, validates lengths and closes on abort without buffering', async () => {
  const storage = new MediaStorageService({
    accountId: 'a'.repeat(32),
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucket: 'unit-test',
  });
  const key = `photos/${randomUUID()}/${randomUUID()}/video.mp4`;
  const source = new Readable({ read() {} });
  let observed: unknown;
  Object.assign(storage, {
    client: {
      send: async (command: { input: unknown }) => {
        observed = command.input;
        return { Body: source, ContentLength: 2, ContentRange: 'bytes 1-2/4' };
      },
      destroy() {},
    },
  });
  const abort = new AbortController();
  assert.equal(
    await storage.openVideo(
      key,
      4,
      { start: 1, end: 2, length: 2 },
      abort.signal
    ),
    source
  );
  assert.equal((observed as { Range: string }).Range, 'bytes=1-2');
  abort.abort();
  assert.equal(source.destroyed, true);
  const invalid = Readable.from([Buffer.from('bad')]);
  Object.assign(storage, {
    client: {
      send: async () => ({ Body: invalid, ContentLength: 3 }),
      destroy() {},
    },
  });
  await assert.rejects(
    storage.openVideo(key, 4, null, new AbortController().signal)
  );
  assert.equal(invalid.destroyed, true);
  storage.onModuleDestroy();
});

test('an R2 error during the post-open permission query is handled and becomes 503', async () => {
  const { PhotosService } = await import('../src/domain/photos/photos.service');
  const storage = new MediaStorageService({
    accountId: 'a'.repeat(32),
    accessKeyId: 'test',
    secretAccessKey: 'test',
    bucket: 'unit-test',
  });
  const body = new Readable({ read() {} });
  Object.assign(storage, {
    client: {
      send: async () => {
        setImmediate(() => body.destroy(new Error('synthetic upstream error')));
        return { Body: body, ContentLength: 4 };
      },
      destroy() {},
    },
  });
  let calls = 0;
  const variant = {
    objectKey: `photos/${randomUUID()}/${randomUUID()}/video.mp4`,
    bytes: 4n,
  };
  const repository = {
    videoVariant: async () => {
      if (++calls > 1)
        await new Promise<void>((resolve) =>
          setImmediate(() => setImmediate(resolve))
        );
      return variant;
    },
  };
  const service = new PhotosService(repository as never, storage, {} as never);
  const video = await service.videoContent(
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  );
  await assert.rejects(
    video.open(null, new AbortController().signal),
    (error: unknown) =>
      error instanceof ServiceUnavailableException && error.getStatus() === 503
  );
  assert.equal(body.destroyed, true);
  storage.onModuleDestroy();
});
