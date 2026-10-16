import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';
import { memoryCalendar } from '../src/domain/memories/memory-date';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import { createAdminAccount } from '../src/admin/cli/admin-account-commands';
import {
  ADMIN_VIEW_LIMIT,
  ADMIN_VIEW_WINDOW_MS,
} from '../src/admin/admin-content-policy';
import {
  encryptTotpSecret,
  generateTotpSecret,
  totpCode,
} from '../src/admin/totp';
import { GroupCleanupRepository } from '../src/worker/group-cleanup/group-cleanup.repository';
import { PhotoProcessingService } from '../src/worker/photo-processing/photo-processing.service';

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
const MINUTE = 60_000;
const MB = 1024 * 1024;

// Synthetic clips made by the same ffmpeg the worker uses (never personal media).
function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
  ]);
  assert.equal(result.status, 0, 'ffmpeg fixture generation failed');
}
function probe(path: string) {
  const result = spawnSync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout.toString()) as {
    streams: Record<string, unknown>[];
    format: { duration: string; tags?: Record<string, string> };
  };
}

test('isolated PostgreSQL: W07-3 video upload, transcode, playback and cleanup', async (t) => {
  isolated('DATABASE_URL');
  const owner = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
    max: 3,
  });
  const app = await createApp();
  const work = mkdtempSync(join(tmpdir(), 'woori-video-fixtures-'));
  const memberOrigin = process.env.WEB_ORIGIN!;
  const mutate = (op: Test) =>
    op.set('Origin', memberOrigin).set('X-Woori-Request', '1');
  const suffix = randomBytes(3).toString('hex');
  const password = `video-integration-pass-${suffix}`;
  const env = {
    ffmpeg: process.env.FFMPEG_PATH,
    ffprobe: process.env.FFPROBE_PATH,
  };
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    // Clips: H.264 MP4 with capture time + location metadata, HEVC QuickTime,
    // one over the 60.5 s limit, an audio-only MP4 and random bytes.
    const clip = (name: string) => join(work, name);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-metadata',
      'creation_time=2021-05-05T03:00:00Z',
      '-metadata',
      'location=+37.5665+126.9780/',
      clip('h264.mp4'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-t',
      '1.5',
      '-c:v',
      'libx265',
      '-tag:v',
      'hvc1',
      '-pix_fmt',
      'yuv420p',
      '-x265-params',
      'log-level=error',
      '-metadata',
      'com.apple.quicktime.creationdate=2026-10-16T00:30:00+0900',
      '-metadata',
      'com.apple.quicktime.location.ISO6709=+37.5665+126.9780/',
      '-movflags',
      'use_metadata_tags',
      clip('hevc.mov'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:size=64x64:rate=1',
      '-t',
      '62',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      clip('long.mp4'),
    ]);
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      clip('audio.mp4'),
    ]);
    writeFileSync(clip('junk.mp4'), randomBytes(4096));
    assert.match(
      String(probe(clip('h264.mp4')).format.tags?.location ?? ''),
      /37\.5665/
    );

    // Fake private bucket: staging objects come from the clips; written objects
    // are copied to disk so the test inspects the real transcoder output.
    const storage = app.get(MediaStorageService);
    const staged = new Map<string, { path: string; mime: string }>();
    const bucket = new Map<string, string>();
    const cleaned: string[] = [];
    const signed: { key: string; download: boolean; filename?: string }[] = [];
    const removed: string[] = [];
    Object.assign(storage, {
      enabled: () => true,
      presign: async () => ({
        uploadUrl: 'https://upload.example.test/staging',
        headers: { 'Content-Type': 'video/mp4' },
        expiresAt: new Date(Date.now() + 10 * MINUTE),
      }),
      downloadToFile: async (key: string, path: string) => {
        const source = staged.get(key);
        if (!source) throw new Error('missing staging object');
        copyFileSync(source.path, path);
        return { bytes: statSync(path).size, contentType: source.mime };
      },
      putFile: async (key: string, path: string) => {
        const copy = join(work, `out-${randomUUID()}`);
        copyFileSync(path, copy);
        bucket.set(key, copy);
      },
      put: async (key: string, data: Buffer) => {
        const copy = join(work, `out-${randomUUID()}`);
        writeFileSync(copy, data);
        bucket.set(key, copy);
      },
      cleanup: async (keys: string[]) => {
        cleaned.push(...keys);
        for (const key of keys) bucket.delete(key);
      },
      read: async (key: string) => {
        const path = bucket.get(key);
        if (!path) throw new Error('missing object');
        const data = readFileSync(path);
        return {
          body: Readable.from([data]),
          contentType: 'image/webp',
          byteSize: data.length,
        };
      },
      signedVideoUrl: async (
        key: string,
        disposition: { download: boolean; filename?: string }
      ) => {
        signed.push({ key, ...disposition });
        return {
          url: `https://r2.example.test/signed/${randomUUID()}`,
          expiresAt: new Date(Date.now() + 10 * MINUTE),
        };
      },
      // The real removePhotoObjects (and its allowed-key check) runs on top.
      listPhotoKeys: async (prefix: string) =>
        [...bucket.keys()].filter((key) => key.startsWith(prefix)),
      removeAndConfirm: async (key: string) => {
        removed.push(key);
        bucket.delete(key);
      },
    });
    const worker = new PhotoProcessingService(
      app.get(PhotosRepository),
      storage
    );
    const drain = async () => {
      for (let index = 0; index < 10; index++) {
        const result = await worker.runBatch(2);
        if (!result.completed && !result.retried) break;
      }
    };

    const fixtureHash = await hashPassword(password);
    const account = async (label: string) => {
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
      return { agent, id: user.id };
    };
    const uploader = await account('video_owner'),
      member = await account('video_member'),
      outsider = await account('video_outsider'),
      leaver = await account('video_leaver');
    const groupId = (
      await mutate(uploader.agent.post('/v1/groups'))
        .send({ name: '동영상 가족' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(uploader.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 5 })
        .expect(201)
    ).body;
    for (const who of [member, leaver])
      await app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, who.id);
    const albumId = (
      await mutate(uploader.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '여름 영상' })
        .expect(201)
    ).body.album.id as string;
    const base = `/v1/groups/${groupId}/albums/${albumId}`;
    const raw = async (id: string) =>
      (await owner.query('SELECT * FROM woori.photos WHERE id=$1', [id]))
        .rows[0];
    const usedBytes = async () =>
      BigInt(
        (
          await owner.query(
            'SELECT "usedBytes" FROM woori.groups WHERE id=$1',
            [groupId]
          )
        ).rows[0].usedBytes
      );
    const variants = async (id: string) =>
      (
        await owner.query(
          'SELECT kind,"objectKey",mime,bytes,width,height FROM woori.photo_variants WHERE "photoId"=$1 ORDER BY kind',
          [id]
        )
      ).rows;
    // Ticket -> R2 PUT (fake) -> process queue.
    const queue = async (
      file: string,
      mime: string,
      who = uploader,
      bytes = statSync(clip(file)).size
    ) => {
      const ticket = (
        await mutate(who.agent.post(`${base}/uploads`))
          .send({ filename: file, contentType: mime, bytes })
          .expect(201)
      ).body;
      const row = await raw(ticket.photoId);
      staged.set(row.stagingKey, { path: clip(file), mime });
      await mutate(who.agent.post(`${base}/photos/${ticket.photoId}/process`))
        .send({})
        .expect(202);
      return {
        id: ticket.photoId as string,
        stagingKey: row.stagingKey as string,
      };
    };
    const state = async (id: string, who = uploader) =>
      (await who.agent.get(`${base}/photos/${id}/processing`).expect(200)).body;
    let h264 = '';
    let hevc = '';

    await t.test(
      'migration and runtime grants keep media identity immutable',
      async () => {
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = (
            await runtime.query(
              `SELECT has_table_privilege(current_user,'woori.photos','UPDATE') AS "tableUpdate",
              has_column_privilege(current_user,'woori.photos','mediaKind','UPDATE') AS "mediaKind",
              has_column_privilege(current_user,'woori.photos','uploaderId','UPDATE') AS "uploader",
              has_column_privilege(current_user,'woori.photos','albumId','UPDATE') AS "album",
              has_column_privilege(current_user,'woori.photos','durationMs','UPDATE') AS "duration",
              has_column_privilege(current_user,'woori.photos','status','UPDATE') AS "status",
              has_column_privilege(current_user,'woori.photos','manualCapturedDate','UPDATE') AS "manualDate",
              has_table_privilege(current_user,'woori.photos','INSERT') AS "insert",
              has_table_privilege(current_user,'woori.photos','DELETE') AS "delete",
              has_table_privilege(current_user,'woori.photos','TRUNCATE') AS "truncate"`
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            tableUpdate: false,
            mediaKind: false,
            uploader: false,
            album: false,
            duration: true,
            status: true,
            manualDate: true,
            insert: true,
            delete: false,
            truncate: false,
          });
          for (const statement of [
            `UPDATE woori.photos SET "mediaKind"='VIDEO' WHERE false`,
            'UPDATE woori.photos SET "uploaderId"="uploaderId" WHERE false',
          ])
            await assert.rejects(
              runtime.query(statement),
              (error: { code?: string }) => error.code === '42501'
            );
        } finally {
          await runtime.end();
        }
        // Only a video can carry a (bounded) duration.
        const photo = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES ($1,$2,$3,$4,'READY',10,10,1)`,
          [photo, groupId, albumId, uploader.id]
        );
        for (const [kind, duration] of [
          ['PHOTO', 1000],
          ['VIDEO', 61001],
          ['VIDEO', 0],
        ] as const)
          await assert.rejects(
            owner.query(
              'UPDATE woori.photos SET "mediaKind"=$2,"durationMs"=$3 WHERE id=$1',
              [photo, kind, duration]
            ),
            (error: { code?: string }) => error.code === '23514'
          );
        await owner.query('DELETE FROM woori.photos WHERE id=$1', [photo]);
      }
    );

    await t.test(
      'upload tickets accept MP4/QuickTime up to 200 MB; images stay at 30 MB',
      async () => {
        const ticket = (contentType: string, bytes: number) =>
          mutate(uploader.agent.post(`${base}/uploads`)).send({
            filename: 'x',
            contentType,
            bytes,
          });
        assert.equal(
          (await ticket('image/jpeg', 30 * MB + 1).expect(400)).body.code,
          'INVALID_PHOTO_FILE'
        );
        await ticket('video/mp4', 200 * MB + 1).expect(400);
        await ticket('video/webm', 1000).expect(400);
        const big = (await ticket('video/quicktime', 200 * MB).expect(201))
          .body;
        const row = await raw(big.photoId);
        assert.equal(row.mediaKind, 'VIDEO');
        assert.equal(row.uploadMime, 'video/quicktime');
        assert.equal(BigInt(row.reservedBytes), 200n * BigInt(MB));
        // The synchronous legacy completion never transcodes inside a request.
        const complete = await mutate(
          uploader.agent.post(`${base}/photos/${big.photoId}/complete`)
        ).expect(409);
        assert.equal(complete.body.code, 'VIDEO_QUEUE_REQUIRED');
        assert.equal((await raw(big.photoId)).status, 'PENDING');
        await mutate(
          uploader.agent.delete(`${base}/photos/${big.photoId}`)
        ).expect(204);
      }
    );

    await t.test(
      'H.264 and HEVC sources become READY H.264 MP4s with posters and no metadata',
      async () => {
        const before = await usedBytes();
        const a = await queue('h264.mp4', 'video/mp4');
        const b = await queue('hevc.mov', 'video/quicktime');
        h264 = a.id;
        hevc = b.id;
        assert.equal((await state(a.id)).status, 'PROCESSING');
        await drain();
        for (const job of [a, b]) {
          const done = await state(job.id);
          assert.equal(done.status, 'READY');
          assert.equal(done.photo.mediaKind, 'VIDEO');
          assert.ok(
            Math.abs(done.photo.durationMs - (job === a ? 2000 : 1500)) <= 100
          );
          const rows = await variants(job.id);
          assert.deepEqual(
            rows.map((row) => row.kind),
            ['preview', 'thumbnail', 'video']
          );
          const video = rows.find((row) => row.kind === 'video')!;
          assert.match(
            video.objectKey,
            new RegExp(`^photos/${job.id}/[0-9a-f-]{36}/video\\.mp4$`)
          );
          assert.equal(video.mime, 'video/mp4');
          // Quota counts exactly the stored transcode + posters; nothing reserved.
          const photo = await raw(job.id);
          assert.equal(
            BigInt(photo.bytes),
            rows.reduce((sum, row) => sum + BigInt(row.bytes), 0n)
          );
          assert.equal(BigInt(photo.reservedBytes), 0n);
          // The original is gone: staging cleaned, no original variant stored.
          assert.ok(cleaned.includes(job.stagingKey));
          assert.ok(
            ![...bucket.keys()].some(
              (key) => key.includes(job.id) && key.includes('original')
            )
          );
          const output = probe(bucket.get(video.objectKey)!);
          const stream = output.streams.find((s) => s.codec_type === 'video')!;
          assert.equal(stream.codec_name, 'h264');
          assert.equal(stream.pix_fmt, 'yuv420p');
          assert.ok(
            output.streams.some((s) => s.codec_type === 'audio') === (job === a)
          );
          assert.doesNotMatch(
            JSON.stringify(output.format.tags ?? {}),
            /location|ISO6709|creation/i
          );
          assert.equal(Number(video.width), stream.width);
          assert.equal(Number(video.height), stream.height);
          // faststart: the moov atom precedes the media data.
          const bytes = readFileSync(bucket.get(video.objectKey)!);
          assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'));
          const thumbnail = rows.find((row) => row.kind === 'thumbnail')!;
          assert.ok(
            Math.max(Number(thumbnail.width), Number(thumbnail.height)) <= 480
          );
        }
        const a1 = await raw(a.id);
        assert.equal(
          new Date(a1.capturedAt).toISOString(),
          '2021-05-05T03:00:00.000Z'
        );
        assert.equal(a1.captureDateSource, 'EXIF');
        assert.equal(
          new Date((await raw(b.id)).capturedAt).toISOString(),
          '2026-10-15T15:30:00.000Z'
        );
        assert.equal(
          await usedBytes(),
          before + BigInt(a1.bytes) + BigInt((await raw(b.id)).bytes)
        );
      }
    );

    await t.test(
      'lists, album stats, memories and notifications include videos',
      async () => {
        const list = (await member.agent.get(`${base}/photos`).expect(200)).body
          .photos as {
          id: string;
          mediaKind: string;
          durationMs: number | null;
        }[];
        const item = list.find((photo) => photo.id === h264)!;
        assert.equal(item.mediaKind, 'VIDEO');
        assert.ok(item.durationMs! >= 1900);
        const album = (
          await member.agent.get(`/v1/groups/${groupId}/albums`).expect(200)
        ).body.albums.find((entry: { id: string }) => entry.id === albumId);
        assert.equal(album.photoCount, 2);
        assert.equal(album.videoCount, 2);
        assert.equal(album.coverMediaKind, 'VIDEO');
        assert.equal(album.startDate, '2021-05-05');
        assert.equal(album.endDate, '2026-10-16');
        const inbox = (await member.agent.get('/v1/notifications').expect(200))
          .body.notifications;
        const bundle = inbox.find(
          (n: { kind: string; albumId: string }) =>
            n.kind === 'PHOTOS' && n.albumId === albumId
        );
        assert.ok(bundle);
        assert.equal(bundle.count, 2);
        assert.equal(bundle.videoCount, 2);
        assert.equal(bundle.mediaKind, 'VIDEO');
        // A push deep link resolves the target with its media kind.
        const target = (
          await member.agent
            .get(`/v1/notifications/${bundle.id}/target`)
            .expect(200)
        ).body;
        assert.equal(target.navigation, 'ALBUM');
        assert.equal(target.mediaKind, 'VIDEO');
        // A video dated "today" in an earlier year is a memory like a photo.
        const calendar = memoryCalendar();
        const day =
          calendar.month === 2 && calendar.day === 29 ? 28 : calendar.day;
        await owner.query(
          'UPDATE woori.photos SET "manualCapturedDate"=$2 WHERE id=$1',
          [
            hevc,
            `${calendar.year - 1}-${String(calendar.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          ]
        );
        const memories = (
          await member.agent
            .get(`/v1/groups/${groupId}/memories?kind=today`)
            .expect(200)
        ).body.items;
        const memory = memories.find(
          (entry: { photo: { id: string } }) => entry.photo.id === hevc
        );
        assert.equal(memory?.photo.mediaKind, 'VIDEO');
        assert.ok(memory?.photo.durationMs > 0);
      }
    );

    await t.test(
      'playback and download use short-lived signed URLs after the access check',
      async () => {
        const play = (
          await member.agent.get(`${base}/photos/${h264}/video`).expect(200)
        ).body;
        assert.deepEqual(Object.keys(play).sort(), [
          'bytes',
          'durationMs',
          'expiresAt',
          'height',
          'mime',
          'purpose',
          'url',
          'width',
        ]);
        assert.equal(play.purpose, 'play');
        assert.equal(play.mime, 'video/mp4');
        assert.ok(Date.parse(play.expiresAt) - Date.now() <= 10 * MINUTE);
        const videoKey = (await variants(h264)).find(
          (row) => row.kind === 'video'
        )!.objectKey;
        assert.deepEqual(signed.at(-1), { key: videoKey, download: false });
        const download = (
          await member.agent
            .get(`${base}/photos/${h264}/video?purpose=download`)
            .expect(200)
        ).body;
        assert.equal(download.purpose, 'download');
        assert.deepEqual(signed.at(-1), {
          key: videoKey,
          download: true,
          filename: `woori-${h264}.mp4`,
        });
        await member.agent
          .get(`${base}/photos/${h264}/video?purpose=stream`)
          .expect(400);
        // Posters are the photo variants; there is no original to download.
        await member.agent
          .get(`${base}/photos/${h264}/content?variant=thumbnail`)
          .expect(200);
        await member.agent
          .get(`${base}/photos/${h264}/content?variant=original`)
          .expect(404);
        const count = signed.length;
        await outsider.agent.get(`${base}/photos/${h264}/video`).expect(404);
        await api.get(`${base}/photos/${h264}/video`).expect(401);
        const photo = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES ($1,$2,$3,$4,'READY',10,10,1)`,
          [photo, groupId, albumId, uploader.id]
        );
        await member.agent.get(`${base}/photos/${photo}/video`).expect(404);
        await owner.query(
          'UPDATE woori.photos SET "deletedAt"=now(),status=\'DELETING\' WHERE id=$1',
          [photo]
        );
        // A viewer who blocked the uploader cannot get a URL.
        await mutate(member.agent.put(`/v1/blocks/${uploader.id}`)).expect(200);
        await member.agent.get(`${base}/photos/${h264}/video`).expect(404);
        await mutate(member.agent.delete(`/v1/blocks/${uploader.id}`)).expect(
          204
        );
        assert.equal(
          signed.length,
          count,
          'No URL is signed for a denied request'
        );
      }
    );

    await t.test(
      'invalid videos fail with codes, release the reservation and leave no objects',
      async () => {
        const expect = async (file: string, mime: string, code: string) => {
          const job = await queue(file, mime);
          await drain();
          const done = await state(job.id);
          assert.equal(done.status, 'FAILED', file);
          assert.equal(done.errorCode, code, file);
          const row = await raw(job.id);
          assert.equal(BigInt(row.reservedBytes), 0n);
          assert.ok(
            cleaned.includes(job.stagingKey),
            `${file} staging cleaned`
          );
          assert.ok(
            ![...bucket.keys()].some((key) =>
              key.startsWith(`photos/${job.id}/`)
            )
          );
          assert.deepEqual(await variants(job.id), []);
        };
        await expect('long.mp4', 'video/mp4', 'VIDEO_TOO_LONG');
        await expect('junk.mp4', 'video/mp4', 'VIDEO_UNSUPPORTED');
        await expect('audio.mp4', 'video/mp4', 'VIDEO_UNSUPPORTED');
        // A declared type that does not match the stored object is rejected too.
        const mismatch = await queue('h264.mp4', 'video/mp4');
        staged.set(mismatch.stagingKey, {
          path: clip('h264.mp4'),
          mime: 'video/quicktime',
        });
        await drain();
        assert.equal((await state(mismatch.id)).errorCode, 'VIDEO_UNSUPPORTED');
        // An encoder failure on a valid source is terminal (no CPU-burning retries).
        process.env.FFMPEG_PATH = '/usr/bin/false';
        try {
          await expect('h264.mp4', 'video/mp4', 'TRANSCODE_FAILED');
        } finally {
          if (env.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
          else process.env.FFMPEG_PATH = env.ffmpeg;
        }
      }
    );

    await t.test(
      'missing tools retry; an inactive uploader fails with UPLOADER_INACTIVE',
      async () => {
        process.env.FFPROBE_PATH = join(work, 'missing-ffprobe');
        let job;
        try {
          job = await queue('h264.mp4', 'video/mp4');
          await worker.runBatch(1);
          const waiting = await state(job.id);
          assert.equal(waiting.status, 'PROCESSING');
          assert.equal(waiting.phase, 'RETRY_WAIT');
          assert.ok(
            !cleaned.includes(job.stagingKey),
            'A retried job keeps its staging object'
          );
        } finally {
          if (env.ffprobe === undefined) delete process.env.FFPROBE_PATH;
          else process.env.FFPROBE_PATH = env.ffprobe;
        }
        await owner.query(
          'UPDATE woori.photos SET "processingAvailableAt"=$2 WHERE id=$1',
          [job.id, new Date(Date.now() - 1000)]
        );
        await drain();
        assert.equal((await state(job.id)).status, 'READY');
        const suspended = await queue('h264.mp4', 'video/mp4');
        await owner.query(
          "UPDATE woori.users SET status='SUSPENDED' WHERE id=$1",
          [uploader.id]
        );
        try {
          await drain();
        } finally {
          await owner.query(
            "UPDATE woori.users SET status='ACTIVE' WHERE id=$1",
            [uploader.id]
          );
        }
        const row = await raw(suspended.id);
        assert.equal(row.status, 'FAILED');
        assert.equal(row.processingErrorCode, 'UPLOADER_INACTIVE');
        assert.ok(cleaned.includes(suspended.stagingKey));
      }
    );

    await t.test(
      'the audited admin view serves the poster and a signed transcode URL',
      async () => {
        const adminOrigin = process.env.ADMIN_WEB_ORIGIN!;
        const totpKey = process.env.ADMIN_TOTP_ENCRYPTION_KEY!;
        const adminMutation = (op: Test) =>
          op.set('Origin', adminOrigin).set('X-Woori-Request', '1');
        const tokenOf = (res: Response) => {
          const header = ([] as string[])
            .concat(res.headers['set-cookie'] ?? [])
            .find((value) => value.startsWith('woori_admin_session='));
          const match = /^woori_admin_session=([A-Za-z0-9_-]{43});/.exec(
            header ?? ''
          );
          assert.ok(match);
          return match[1];
        };
        await owner.query(
          'DELETE FROM woori.rate_limit_buckets WHERE id = ANY($1)',
          [
            ['127.0.0.1', '::ffff:127.0.0.1', '::1'].flatMap((ip) =>
              ['admin-login-ip', 'admin-mfa-ip'].map(
                (scope) =>
                  rateLimitKey(
                    'auth',
                    `${scope}:${ip}`,
                    new Date(),
                    15 * MINUTE
                  ).id
              )
            ),
          ]
        );
        const client = await owner.connect();
        const admin = await createAdminAccount(client, {
          username: `video_${suffix}`,
          displayName: '동영상 운영자',
          password,
        }).finally(() => client.release());
        const secret = generateTotpSecret();
        await owner.query(
          'UPDATE woori.admin_accounts SET "totpSecretCiphertext"=$2,"totpEnabledAt"=now() WHERE id=$1',
          [admin.id, encryptTotpSecret(secret, totpKey, admin.id)]
        );
        const preMfa = tokenOf(
          await adminMutation(api.post('/v1/admin/auth/login'))
            .send({ username: admin.username, password })
            .expect(200)
        );
        const token = tokenOf(
          await adminMutation(api.post('/v1/admin/auth/mfa/verify'))
            .set('Cookie', `woori_admin_session=${preMfa}`)
            .send({ code: totpCode(secret, Date.now()) })
            .expect(200)
        );
        const post = (path: string) =>
          adminMutation(api.post(path)).set(
            'Cookie',
            `woori_admin_session=${token}`
          );
        const reason = '신고 확인을 위한 동영상 열람';
        const count = signed.length;
        const view = (
          await post(`/v1/admin/photos/${hevc}/video`)
            .send({ reason })
            .expect(200)
        ).body;
        assert.deepEqual(Object.keys(view).sort(), [
          'bytes',
          'durationMs',
          'expiresAt',
          'mime',
          'url',
        ]);
        assert.equal(signed.length, count + 1);
        assert.equal(signed.at(-1)!.download, false);
        const audits = (
          await owner.query(
            'SELECT reason,metadata FROM woori.admin_audit_logs WHERE action=\'ADMIN_VIDEO_VIEWED\' AND "targetId"=$1',
            [hevc]
          )
        ).rows;
        assert.equal(audits.length, 1);
        assert.equal(audits[0].reason, reason);
        assert.deepEqual(audits[0].metadata, { photoId: hevc, groupId });
        await post(`/v1/admin/photos/${hevc}/view`)
          .send({ reason })
          .expect(200);
        // Refusals issue no URL and write no audit row.
        const issued = signed.length;
        const videoAudits = async () =>
          (
            await owner.query(
              'SELECT count(*)::int AS n FROM woori.admin_audit_logs WHERE action=\'ADMIN_VIDEO_VIEWED\' AND "targetId"=$1',
              [hevc]
            )
          ).rows[0].n as number;
        // A written reason is required.
        for (const body of [{}, { reason: '' }, { reason: '짧음' }])
          await post(`/v1/admin/photos/${hevc}/video`).send(body).expect(400);
        // Re-authentication older than 10 minutes.
        await owner.query(
          `UPDATE woori.admin_sessions SET "reauthAt"=now()-interval '11 minutes' WHERE "tokenHash"=$1`,
          [hashToken(token)]
        );
        assert.equal(
          (
            await post(`/v1/admin/photos/${hevc}/video`)
              .send({ reason })
              .expect(403)
          ).body.code,
          'ADMIN_REAUTH_REQUIRED'
        );
        await owner.query(
          'UPDATE woori.admin_sessions SET "reauthAt"=now() WHERE "tokenHash"=$1',
          [hashToken(token)]
        );
        // The per-admin view limit (shared with photo/comment views). The next
        // window's bucket is filled too so an hour boundary cannot flake it.
        const buckets = [0, 60_000].map((ahead) =>
          rateLimitKey(
            'auth',
            `admin-view:${admin.id}`,
            new Date(Date.now() + ahead),
            ADMIN_VIEW_WINDOW_MS
          )
        );
        for (const bucket of buckets)
          await owner.query(
            'INSERT INTO woori.rate_limit_buckets (id,"windowStart",attempts) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET attempts=EXCLUDED.attempts',
            [bucket.id, bucket.windowStart, ADMIN_VIEW_LIMIT]
          );
        assert.equal(
          (
            await post(`/v1/admin/photos/${hevc}/video`)
              .send({ reason })
              .expect(429)
          ).body.code,
          'TOO_MANY_REQUESTS'
        );
        await owner.query(
          'DELETE FROM woori.rate_limit_buckets WHERE id = ANY($1)',
          [buckets.map((bucket) => bucket.id)]
        );
        assert.equal(signed.length, issued);
        assert.equal(await videoAudits(), 1);
        const photo = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos (id,"groupId","albumId","uploaderId",status,width,height,bytes) VALUES ($1,$2,$3,$4,'READY',10,10,1)`,
          [photo, groupId, albumId, uploader.id]
        );
        assert.equal(
          (
            await post(`/v1/admin/photos/${photo}/video`)
              .send({ reason })
              .expect(404)
          ).body.code,
          'ADMIN_PHOTO_NOT_FOUND'
        );
        await owner.query(
          'UPDATE woori.photos SET "deletedAt"=now(),status=\'DELETING\' WHERE id=$1',
          [photo]
        );
        // Member sessions never reach the admin realm.
        await mutate(member.agent.post(`/v1/admin/photos/${hevc}/video`))
          .send({ reason })
          .expect((res) => assert.ok([401, 403].includes(res.status)));
        const items = (
          await api
            .get(
              `/v1/admin/groups/${groupId}/albums/${albumId}/photos?limit=50`
            )
            .set('X-Woori-Request', '1')
            .set('Cookie', `woori_admin_session=${token}`)
            .expect(200)
        ).body.items;
        const listed = items.find((entry: { id: string }) => entry.id === hevc);
        assert.equal(listed.mediaKind, 'VIDEO');
        assert.ok(listed.durationMs > 0);
      }
    );

    await t.test(
      'deletion, withdrawal and group deletion queue every video object',
      async () => {
        const keys = (await variants(h264)).map((row) => row.objectKey);
        const bytes = BigInt((await raw(h264)).bytes);
        const before = await usedBytes();
        await mutate(uploader.agent.delete(`${base}/photos/${h264}`)).expect(
          204
        );
        assert.equal(await usedBytes(), before - bytes);
        const job = (
          await owner.query(
            'SELECT "objectKeys" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
            [h264]
          )
        ).rows[0];
        for (const key of keys) assert.ok(job.objectKeys.includes(key));
        // The real allowed-key check of the cleanup worker accepts every
        // video object (stubbed bucket listing/removal underneath). The queue
        // itself is not run here: it would also sweep other suites' jobs.
        await storage.removePhotoObjects(h264, job.objectKeys);
        for (const key of keys) assert.ok(removed.includes(key), key);
        assert.equal(
          [...bucket.keys()].some((key) => key.startsWith(`photos/${h264}/`)),
          false
        );
        // A withdrawing member's unfinished video upload is queued for cleanup.
        const pending = (
          await mutate(leaver.agent.post(`${base}/uploads`))
            .send({ filename: 'p.mp4', contentType: 'video/mp4', bytes: 1000 })
            .expect(201)
        ).body.photoId;
        const stagingKey = (await raw(pending)).stagingKey;
        await mutate(leaver.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        const leaverJob = (
          await owner.query(
            'SELECT "objectKeys" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
            [pending]
          )
        ).rows[0];
        assert.deepEqual(leaverJob.objectKeys, [stagingKey]);
        // Group deletion tombstones remaining videos with all their objects.
        const hevcKeys = (await variants(hevc)).map((row) => row.objectKey);
        await mutate(uploader.agent.delete(`/v1/groups/${groupId}`))
          .send({ name: '동영상 가족' })
          .expect(202);
        // Only this suite's group: other suites' deleting groups stay untouched.
        const others = (
          await owner.query(
            "SELECT id FROM woori.groups WHERE status='DELETING' AND id<>$1",
            [groupId]
          )
        ).rows.map((row) => row.id as string);
        const sweep = new GroupCleanupRepository(app.get(PrismaService));
        for (let pass = 0; pass < 5; pass++)
          if (!(await sweep.progress(others))) break;
        const groupJob = (
          await owner.query(
            'SELECT "objectKeys" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
            [hevc]
          )
        ).rows[0];
        for (const key of hevcKeys)
          assert.ok(groupJob.objectKeys.includes(key), key);
      }
    );
  } finally {
    if (env.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = env.ffmpeg;
    if (env.ffprobe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = env.ffprobe;
    rmSync(work, { recursive: true, force: true });
    await app.close();
    await owner.end();
  }
});
