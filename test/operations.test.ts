import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptMailPayload,
  encryptMailPayload,
} from '../src/common/mail/mail-crypto';
import { mailConfigured, mailOutboxKey } from '../src/common/mail/mail-config';
import {
  assertProductionConfig,
  productionConfigProblems,
  sessionCookieProblems,
} from '../src/common/configurations/production.config';
import { startupFailure } from '../src/common/configurations/startup-diagnostics';
import {
  BACKUP_LAST_SUCCESS_KEY,
  BACKUP_MANIFEST_KEY,
  BACKUP_PREFIXES,
  BackupSafetyError,
  MAX_BACKUP_MANIFEST_BYTES,
  backupFailureSummary,
  lastSuccessRecord,
  manifestSizeStatus,
  parseBackupManifest,
  planR2Backup,
  sourceGone,
} from '../src/common/media/r2-backup';
import {
  MailDeliveryError,
  MailService,
} from '../src/domain/auth/mail.service';
import { mailRetryDelayMs } from '../src/domain/mail/mail-outbox';

const key = randomBytes(32);

test('mail payloads are AES-GCM sealed to their outbox row', () => {
  const id = randomUUID();
  const sealed = encryptMailPayload(
    { to: 'member@example.test', token: 'raw-token-value' },
    key,
    id
  );
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  for (const secret of ['member@example.test', 'raw-token-value'])
    assert.ok(!sealed.includes(secret));
  assert.notEqual(
    sealed,
    encryptMailPayload({ to: 'member@example.test' }, key, id)
  );
  assert.deepEqual(decryptMailPayload(sealed, key, id), {
    to: 'member@example.test',
    token: 'raw-token-value',
  });
  // Another row, another key or a flipped byte never decrypts.
  assert.throws(() => decryptMailPayload(sealed, key, randomUUID()));
  assert.throws(() => decryptMailPayload(sealed, randomBytes(32), id));
  const parts = sealed.split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[0] ^= 1;
  parts[3] = body.toString('base64url');
  assert.throws(() => decryptMailPayload(parts.join('.'), key, id));
  assert.throws(() => decryptMailPayload('v2.a.b.c', key, id));
});

test('mail configuration needs a transport, a link origin and the outbox key', () => {
  const valid = {
    MAIL_MODE: 'resend',
    RESEND_API_KEY: 're_test',
    MAIL_FROM: '우리 <no-reply@mail.woori.stream>',
    WEB_ORIGIN: 'https://woori.stream',
    MAIL_OUTBOX_KEY: key.toString('base64'),
  };
  assert.equal(mailConfigured(valid), true);
  for (const missing of Object.keys(valid))
    assert.equal(mailConfigured({ ...valid, [missing]: '' }), false, missing);
  assert.equal(
    mailConfigured({ ...valid, WEB_ORIGIN: 'https://woori.stream/' }),
    false
  );
  assert.equal(
    mailConfigured({
      ...valid,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'http://woori.stream',
    }),
    false
  );
  assert.equal(mailOutboxKey({}), null);
  assert.throws(
    () => mailOutboxKey({ MAIL_OUTBOX_KEY: 'short' }),
    /value redacted/
  );
  assert.equal(mailConfigured({ ...valid, MAIL_OUTBOX_KEY: 'short' }), false);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 9].map(mailRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]
  );
});

test('Resend delivery sends a stable Idempotency-Key and classifies failures', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const name of [
      'MAIL_MODE',
      'RESEND_API_KEY',
      'MAIL_FROM',
      'WEB_ORIGIN',
      'NODE_ENV',
    ])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
  });
  Object.assign(process.env, {
    MAIL_MODE: 'resend',
    RESEND_API_KEY: 're_unit_test',
    MAIL_FROM: '우리 <no-reply@mail.woori.test>',
    WEB_ORIGIN: 'https://woori.test',
    NODE_ENV: 'production',
  });
  const calls: { headers: Record<string, string>; body: string }[] = [];
  let reply: () => Response = () => new Response('{}', { status: 200 });
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      calls.push({
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return reply();
    }
  );
  const mail = new MailService();
  const options = { idempotencyKey: 'woori-mail-fixed', fileName: 'unused' };
  await mail.sendPasswordReset('member@example.test', 'raw-token', options);
  await mail.sendPasswordReset('member@example.test', 'raw-token', options);
  assert.equal(calls.length, 2);
  for (const call of calls)
    assert.equal(call.headers['Idempotency-Key'], 'woori-mail-fixed');
  assert.equal(calls[0].body, calls[1].body, 'Same payload on a retry');
  assert.match(
    calls[0].body,
    /https:\/\/woori\.test\/reset-password\?token=raw-token/
  );
  const outcome = async (make: () => Response) => {
    reply = make;
    try {
      await mail.sendEmailChangedNotice('old@example.test', options);
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof MailDeliveryError);
      return `${error.retryable ? 'retry' : 'stop'}:${error.reason}`;
    }
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  assert.equal(await outcome(() => json(500, {})), 'retry:provider-500');
  assert.equal(await outcome(() => json(429, {})), 'retry:provider-429');
  assert.equal(
    await outcome(() => json(409, { name: 'concurrent_idempotent_requests' })),
    'retry:provider-busy'
  );
  assert.equal(
    await outcome(() => json(409, { name: 'invalid_idempotent_request' })),
    'stop:provider-409'
  );
  assert.equal(await outcome(() => json(422, {})), 'stop:provider-422');
  reply = () => {
    throw new TypeError('network');
  };
  assert.equal(
    await outcome(() => {
      throw new TypeError('network');
    }),
    'retry:provider-unreachable'
  );
});

test('development mail files are written once per outbox mail', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'woori-outbox-mail-'));
  const saved = { ...process.env };
  t.after(async () => {
    for (const name of ['MAIL_MODE', 'DEV_MAIL_DIR', 'WEB_ORIGIN', 'NODE_ENV'])
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    MAIL_MODE: 'file',
    DEV_MAIL_DIR: directory,
    WEB_ORIGIN: 'http://localhost:3210',
    NODE_ENV: 'development',
  });
  const mail = new MailService();
  const options = {
    idempotencyKey: 'k',
    fileName: `1700000000000-${randomUUID()}`,
  };
  await mail.sendVerification('a@example.test', 'raw', options);
  await mail.sendVerification('a@example.test', 'raw', options);
  assert.equal((await readdir(directory)).length, 1);
  await assert.rejects(
    mail.sendVerification('a@example.test', 'raw', { fileName: '../escape' }),
    MailDeliveryError
  );
});

test('production configuration names every missing or unsafe setting, never values', (t) => {
  const valid: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    DATABASE_URL:
      'postgresql://woori_api:secret-db-password@db.example.supabase.co:5432/postgres',
    WEB_ORIGIN: 'https://woori.stream',
    ADMIN_WEB_ORIGIN: 'https://admin.woori.stream',
    CORS_ALLOWED_ORIGINS: 'https://woori.stream,https://admin.woori.stream',
    TRUST_PROXY_HOPS: '1',
    MAIL_MODE: 'resend',
    RESEND_API_KEY: 're_secret_value',
    MAIL_FROM: '우리 <no-reply@mail.woori.stream>',
    MAIL_OUTBOX_KEY: key.toString('base64'),
    ADMIN_TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    R2_ACCOUNT_ID: 'a'.repeat(32),
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret-value',
    R2_BUCKET: 'woori-production',
  };
  assert.deepEqual(productionConfigProblems(valid, 'api'), []);
  assert.deepEqual(productionConfigProblems(valid, 'worker'), []);
  const cases: [Partial<NodeJS.ProcessEnv>, string[]][] = [
    [
      { WEB_ORIGIN: 'http://woori.stream' },
      ['WEB_ORIGIN', 'MAIL_FROM', 'CORS_ALLOWED_ORIGINS'],
    ],
    [
      { ADMIN_WEB_ORIGIN: undefined },
      ['ADMIN_WEB_ORIGIN', 'CORS_ALLOWED_ORIGINS'],
    ],
    [
      { CORS_ALLOWED_ORIGINS: 'https://woori.stream' },
      ['CORS_ALLOWED_ORIGINS'],
    ],
    [
      {
        CORS_ALLOWED_ORIGINS: `${valid.CORS_ALLOWED_ORIGINS},http://localhost:3210`,
      },
      ['CORS_ALLOWED_ORIGINS'],
    ],
    // Exactly the web and admin origins: an extra https origin is refused too.
    [
      {
        CORS_ALLOWED_ORIGINS: `${valid.CORS_ALLOWED_ORIGINS},https://preview.woori.stream`,
      },
      ['CORS_ALLOWED_ORIGINS'],
    ],
    [
      {
        CORS_ALLOWED_ORIGINS:
          'https://admin.woori.stream, https://woori.stream,https://woori.stream',
      },
      [],
    ],
    [{ TRUST_PROXY_HOPS: '0' }, ['TRUST_PROXY_HOPS']],
    [{ MAIL_MODE: 'file' }, ['MAIL_MODE']],
    [{ MAIL_FROM: 'no-reply@other-domain.example' }, ['MAIL_FROM']],
    [{ MAIL_FROM: 'no-reply@notwoori.stream' }, ['MAIL_FROM']],
    [{ MAIL_OUTBOX_KEY: 'short' }, ['MAIL_OUTBOX_KEY']],
    [
      { DATABASE_URL: 'postgresql://woori_api:x@127.0.0.1:55439/woori_dev' },
      ['DATABASE_URL'],
    ],
    [{ R2_ACCOUNT_ID: 'nothex' }, ['R2_ACCOUNT_ID']],
    [{ ADMIN_TOTP_ENCRYPTION_KEY: undefined }, ['ADMIN_TOTP_ENCRYPTION_KEY']],
  ];
  for (const [patch, expected] of cases)
    assert.deepEqual(
      productionConfigProblems({ ...valid, ...patch }, 'api'),
      expected,
      JSON.stringify(Object.keys(patch))
    );
  // The worker has no browser surface: proxy/CORS/admin are not its concern.
  assert.deepEqual(
    productionConfigProblems(
      { ...valid, TRUST_PROXY_HOPS: '0', ADMIN_WEB_ORIGIN: undefined },
      'worker'
    ),
    []
  );
  // Startup error: names only, no secret values.
  const saved = process.env.NODE_ENV;
  t.after(() => {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });
  process.env.NODE_ENV = 'production';
  let failure = '';
  try {
    assertProductionConfig(
      { ...valid, RESEND_API_KEY: '', TRUST_PROXY_HOPS: '2' },
      'api'
    );
  } catch (error) {
    failure = startupFailure(error);
  }
  assert.match(failure, /^\[CONFIG\] .*RESEND_API_KEY, TRUST_PROXY_HOPS/);
  for (const secret of [
    'secret-db-password',
    're_secret_value',
    'r2-secret-value',
  ])
    assert.ok(!failure.includes(secret));
  assert.doesNotThrow(() => assertProductionConfig(valid, 'api'));
  // The cookie check runs the real set/clear helpers: production cookies are
  // __Host- with Secure, Path=/ and no Domain; development ones would fail it.
  assert.deepEqual(sessionCookieProblems(), []);
  process.env.NODE_ENV = 'test';
  assert.deepEqual(sessionCookieProblems(), [
    'SESSION_COOKIE',
    'ADMIN_SESSION_COOKIE',
  ]);
  assert.doesNotThrow(() =>
    assertProductionConfig(
      { ...valid, NODE_ENV: 'test', WEB_ORIGIN: '' },
      'api'
    )
  );
});

const buckets = {
  sourceBucket: 'woori-production',
  backupBucket: 'woori-backup',
};
test('R2 backup copies incrementally and prunes by first-seen orphan age only on request', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const day = 86_400_000;
  const ago = (days: number) => new Date(now.getTime() - days * day);
  const source = [
    { key: 'photos/a/1/video.mp4', size: 10, etag: '"aaa"' },
    { key: 'photos/a/1/display.webp', size: 5, etag: '"bbb"' },
    { key: 'photos/b/2/original.jpg', size: 7, etag: '"ccc"' },
  ];
  const backup = [
    {
      key: 'photos/a/1/video.mp4',
      size: 10,
      etag: 'aaa',
      lastModified: ago(20),
    },
    {
      key: 'photos/a/1/display.webp',
      size: 5,
      etag: '"changed"',
      lastModified: ago(20),
    },
    // Copied 100 days ago, but only just found missing from the source.
    {
      key: 'photos/gone/old.jpg',
      size: 3,
      etag: '"x"',
      lastModified: ago(100),
    },
    {
      key: 'photos/gone/recent.jpg',
      size: 3,
      etag: '"y"',
      lastModified: ago(2),
    },
  ];
  const first = planR2Backup(source, backup, {
    ...buckets,
    manifest: null,
    now,
  });
  assert.deepEqual(
    first.copy.map((object) => object.key),
    ['photos/a/1/display.webp', 'photos/b/2/original.jpg']
  );
  assert.equal(first.unchanged, 1);
  assert.equal(first.copyBytes, 12);
  assert.deepEqual(first.prune, [], 'Never prunes without the explicit flag');
  assert.equal(first.orphaned, 2);
  assert.deepEqual(first.manifest, {
    version: 1,
    sourceBucket: 'woori-production',
    orphans: {
      'photos/gone/old.jpg': now.toISOString(),
      'photos/gone/recent.jpg': now.toISOString(),
    },
  });
  // The backup copy's age is not the orphan's age: nothing is due yet.
  assert.deepEqual(
    planR2Backup(source, backup, {
      ...buckets,
      manifest: null,
      now,
      pruneOlderThanDays: 30,
      forceLargePrune: true,
    }).prune,
    []
  );
  const manifest = parseBackupManifest(
    JSON.stringify({
      version: 1,
      sourceBucket: 'woori-production',
      orphans: {
        'photos/gone/old.jpg': ago(40).toISOString(),
        'photos/gone/recent.jpg': ago(2).toISOString(),
        // Back in the source since: leaves the manifest.
        'photos/b/2/original.jpg': ago(90).toISOString(),
      },
    })
  );
  const later = planR2Backup(source, backup, {
    ...buckets,
    manifest,
    now,
    pruneOlderThanDays: 30,
    forceLargePrune: true,
  });
  assert.deepEqual(later.prune, ['photos/gone/old.jpg']);
  assert.deepEqual(later.manifest.orphans, {
    'photos/gone/old.jpg': ago(40).toISOString(),
    'photos/gone/recent.jpg': ago(2).toISOString(),
  });
  for (const days of [0, 3, 6.5, -1])
    assert.throws(() =>
      planR2Backup(source, backup, {
        ...buckets,
        manifest,
        now,
        pruneOlderThanDays: days,
      })
    );
  assert.equal(
    planR2Backup(source, [], { ...buckets, manifest: null, now }).copy.length,
    3
  );
});

test('R2 backup stops on an empty source, a suspicious target or a large prune', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const seen = new Date(now.getTime() - 60 * 86_400_000).toISOString();
  const kept = Array.from({ length: 100 }, (_, index) => ({
    key: `photos/kept/${index}.jpg`,
    size: 1,
    etag: `"k${index}"`,
  }));
  const gone = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      key: `photos/gone/${index}.jpg`,
      size: 1,
      etag: `"g${index}"`,
    }));
  const manifestFor = (count: number) => ({
    version: 1 as const,
    sourceBucket: 'woori-production',
    orphans: Object.fromEntries(gone(count).map(({ key }) => [key, seen])),
  });
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      return error instanceof BackupSafetyError ? error.code : 'other';
    }
    return null;
  };
  // An empty listing (wrong bucket/prefix/token) would age every backup copy.
  assert.equal(
    code(() =>
      planR2Backup([], kept, { ...buckets, manifest: manifestFor(0), now })
    ),
    'SOURCE_EMPTY'
  );
  assert.equal(
    code(() =>
      planR2Backup(kept, kept, {
        sourceBucket: 'woori-production',
        backupBucket: 'woori-production',
        manifest: null,
        now,
      })
    ),
    'SAME_BUCKET'
  );
  assert.equal(
    code(() =>
      planR2Backup(kept, kept, {
        ...buckets,
        manifest: { ...manifestFor(0), sourceBucket: 'woori-staging' },
        now,
      })
    ),
    'MANIFEST_SOURCE_MISMATCH'
  );
  assert.equal(parseBackupManifest(null), null);
  for (const text of [
    '{',
    '[]',
    JSON.stringify({ version: 2, sourceBucket: 'x', orphans: {} }),
    JSON.stringify({ version: 1, sourceBucket: 'x', orphans: { k: 'later' } }),
  ])
    assert.equal(
      code(() => parseBackupManifest(text)),
      'MANIFEST_INVALID',
      text
    );
  // 6 of 106 backup objects (> 5%): prune is skipped, copy still planned, and
  // the first-seen times are kept for the next run.
  const large = planR2Backup(kept, [...kept, ...gone(6)], {
    ...buckets,
    manifest: manifestFor(6),
    now,
    pruneOlderThanDays: 30,
  });
  assert.deepEqual(large.prune, []);
  assert.equal(large.pruneBlocked, 'PRUNE_RATIO_EXCEEDED');
  assert.equal(large.pruneCandidates, 6);
  assert.equal(Object.keys(large.manifest.orphans).length, 6);
  assert.equal(
    planR2Backup(kept, [...kept, ...gone(6)], {
      ...buckets,
      manifest: manifestFor(6),
      now,
      pruneOlderThanDays: 30,
      forceLargePrune: true,
    }).prune.length,
    6
  );
  // 5 of 105 (<= 5%) prunes without the override.
  const small = planR2Backup(kept, [...kept, ...gone(5)], {
    ...buckets,
    manifest: manifestFor(5),
    now,
    pruneOlderThanDays: 30,
  });
  assert.equal(small.pruneBlocked, null);
  assert.equal(small.prune.length, 5);
});

test('daily R2 backup: deleted sources skip, failures name only the SDK error, success is recorded', () => {
  // Deleted between listing and copy is normal; a missing bucket is not.
  assert.equal(sourceGone({ name: 'NoSuchKey' }), true);
  for (const error of [
    { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } },
    { name: 'AccessDenied' },
    new Error('x'),
    null,
  ])
    assert.equal(sourceGone(error), false);
  assert.deepEqual(
    backupFailureSummary({
      name: 'AccessDenied',
      message: 'Access Denied for bucket woori-private key photos/a',
      $metadata: { httpStatusCode: 403, requestId: 'r' },
    }),
    { status: 'failed', error: 'AccessDenied', httpStatus: 403 }
  );
  // Odd names and messages never leak; a plain error stays generic.
  assert.deepEqual(
    backupFailureSummary({ name: 'https://x.example/photos/a secret' }),
    { status: 'failed', error: 'Error', httpStatus: null }
  );
  assert.deepEqual(backupFailureSummary(undefined), {
    status: 'failed',
    error: 'Error',
    httpStatus: null,
  });
  // The marker and manifest live outside the listed media prefixes; profile
  // photos are backed up with photos, never staging uploads.
  for (const key of [BACKUP_LAST_SUCCESS_KEY, BACKUP_MANIFEST_KEY])
    assert.ok(!BACKUP_PREFIXES.some((prefix) => key.startsWith(prefix)));
  assert.deepEqual([...BACKUP_PREFIXES], ['photos/', 'avatars/']);
  assert.deepEqual(
    lastSuccessRecord({
      sourceBucket: 'woori-media',
      startedAt: new Date('2026-10-20T18:30:00Z'),
      finishedAt: new Date('2026-10-20T18:31:05Z'),
      sourceObjects: 12,
      copied: 2,
      unchanged: 9,
      sourceGone: 1,
    }),
    {
      version: 1,
      sourceBucket: 'woori-media',
      startedAt: '2026-10-20T18:30:00.000Z',
      finishedAt: '2026-10-20T18:31:05.000Z',
      sourceObjects: 12,
      copied: 2,
      unchanged: 9,
      sourceGone: 1,
    }
  );
  assert.equal(manifestSizeStatus(1024), 'ok');
  assert.equal(
    manifestSizeStatus(Math.floor(MAX_BACKUP_MANIFEST_BYTES * 0.8) + 1),
    'near-limit'
  );
  assert.equal(manifestSizeStatus(MAX_BACKUP_MANIFEST_BYTES), 'near-limit');
  assert.equal(manifestSizeStatus(MAX_BACKUP_MANIFEST_BYTES + 1), 'too-large');
});
