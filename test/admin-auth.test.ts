import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { adminConfig } from '../src/common/configurations/admin.config';
import { runtimeConfig } from '../src/common/configurations/runtime.config';
import { startupFailure } from '../src/common/configurations/startup-diagnostics';
import { createToken, sessionToken } from '../src/domain/auth/auth-token';
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../src/admin/totp';
import { adminSessionToken } from '../src/admin/admin-session-token';
import { checkAdminOrigin } from '../src/admin/guards/admin-session.guard';
import {
  ADMIN_LOCKOUT_MS,
  adminAccessError,
  nextFailureState,
  nextIdleExpiry,
  reauthValidUntil,
} from '../src/admin/admin-policy';
import { adminAuditMetadata } from '../src/admin/admin-audit';
import {
  AdminCliError,
  adminCliErrorMessage,
  parseAdminCliArgs,
  targetDatabaseName,
  validateAdminPassword,
} from '../src/admin/cli/admin-account-commands';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

test('TOTP matches RFC 6238 SHA-1 vectors and the 6-digit truncation', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totpCode(RFC_SECRET, seconds * 1000, 8), expected);
    assert.equal(totpCode(RFC_SECRET, seconds * 1000), expected.slice(-6));
  }
});

test('TOTP accepts only ±1 step, rejects replayed or malformed codes', () => {
  // Deterministic secret and time: no accidental code collisions in the window.
  const secret = RFC_SECRET;
  const now = 1_800_000_015_000;
  const step = Math.floor(now / 30_000);
  const code = totpCode(secret, now);
  assert.equal(verifyTotp(secret, code, now, null), step);
  assert.equal(verifyTotp(secret, code, now - 30_000, null), step);
  assert.equal(verifyTotp(secret, code, now + 30_000, null), step);
  assert.equal(verifyTotp(secret, code, now + 60_000, null), null);
  assert.equal(verifyTotp(secret, code, now - 60_000, null), null);
  // Replay: the same or an older step is never accepted again.
  assert.equal(verifyTotp(secret, code, now, step), null);
  assert.equal(verifyTotp(secret, code, now, BigInt(step + 1)), null);
  assert.equal(verifyTotp(secret, code, now, BigInt(step - 1)), step);
  for (const bad of ['', '12345', '1234567', 'abcdef', ` ${code}`])
    assert.equal(verifyTotp(secret, bad, now, null), null);
  assert.equal(
    verifyTotp(Buffer.from('another-secret-value!'), code, now, null),
    null
  );
});

test('base32 follows RFC 4648 and the otpauth URI is properly encoded', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
    assert.equal(base32Decode(`${encoded}======`).toString(), plain);
  }
  const secret = generateTotpSecret();
  assert.equal(secret.length, 20);
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  assert.throws(() => base32Decode('MZXW1'));
  const uri = otpauthUri('ops_admin', secret);
  assert.doesNotMatch(uri, /\s/);
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(
    decodeURIComponent(parsed.pathname.slice(1)),
    '우리 관리자:ops_admin'
  );
  assert.equal(parsed.searchParams.get('secret'), base32Encode(secret));
  assert.equal(parsed.searchParams.get('issuer'), '우리 관리자');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
});

test('TOTP secrets use randomized AES-256-GCM bound to the admin id and reject tampering', () => {
  const key = randomBytes(32).toString('base64');
  const secret = generateTotpSecret();
  const adminId = '6f9fb3c5-8c43-4d39-9b7c-6ad4d3c3a001';
  const encrypted = encryptTotpSecret(secret, key, adminId);
  assert.notEqual(encrypted, encryptTotpSecret(secret, key, adminId));
  assert.doesNotMatch(encrypted, new RegExp(base32Encode(secret)));
  assert.deepEqual(decryptTotpSecret(encrypted, key, adminId), secret);
  const [version, iv, tag, body] = encrypted.split('.');
  const flip = (value: string) => {
    const bytes = Buffer.from(value, 'base64url');
    bytes[0] ^= 1;
    return bytes.toString('base64url');
  };
  for (const tampered of [
    ['v2', iv, tag, body].join('.'),
    [version, flip(iv), tag, body].join('.'),
    [version, iv, flip(tag), body].join('.'),
    [version, iv, tag, flip(body)].join('.'),
    // A truncated authentication tag must not be accepted.
    [
      version,
      iv,
      Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url'),
      body,
    ].join('.'),
    `${encrypted}.extra`,
    'not-encrypted',
  ])
    assert.throws(() => decryptTotpSecret(tampered, key, adminId));
  // Copying a ciphertext to another admin row fails authentication.
  assert.throws(() =>
    decryptTotpSecret(encrypted, key, '6f9fb3c5-8c43-4d39-9b7c-6ad4d3c3a002')
  );
  assert.throws(() =>
    decryptTotpSecret(encrypted, randomBytes(32).toString('base64'), adminId)
  );
});

test('admin and member session cookies are parsed separately and duplicates are rejected', () => {
  const token = createToken();
  const prefix = process.env.NODE_ENV === 'production' ? '__Host-' : '';
  const admin = `${prefix}woori_admin_session`;
  const member = `${prefix}woori_session`;
  const of = (cookie: string) => ({ headers: { cookie } }) as Request;
  assert.equal(adminSessionToken(of(`${admin}=${token}`)), token);
  assert.equal(adminSessionToken(of(`a=b; ${admin}=${token}; c=d`)), token);
  assert.equal(
    adminSessionToken(of(`${admin}=${token}; ${admin}=${createToken()}`)),
    undefined
  );
  assert.equal(adminSessionToken(of(`${admin}=${token}x`)), undefined);
  assert.equal(adminSessionToken(of(`${admin}=`)), undefined);
  assert.equal(adminSessionToken(of('')), undefined);
  // Neither realm's cookie authenticates the other.
  assert.equal(adminSessionToken(of(`${member}=${token}`)), undefined);
  assert.equal(sessionToken(of(`${admin}=${token}`)), undefined);
});

test('admin origin check rejects the member web origin and missing CSRF header', () => {
  const config = {
    webOrigin: 'https://admin.example.test',
    totpEncryptionKey: randomBytes(32).toString('base64'),
  };
  const of = (method: string, headers: Record<string, string>) =>
    ({
      method,
      get: (name: string) => headers[name.toLowerCase()],
    }) as unknown as Request;
  const allowed = [
    of('GET', {}),
    of('GET', { origin: config.webOrigin }),
    of('POST', { origin: config.webOrigin, 'x-woori-request': '1' }),
  ];
  for (const req of allowed) checkAdminOrigin(req, config);
  for (const req of [
    of('GET', { origin: 'https://app.example.test' }),
    of('POST', { 'x-woori-request': '1' }),
    of('POST', { origin: config.webOrigin }),
    of('POST', { origin: 'https://app.example.test', 'x-woori-request': '1' }),
    of('DELETE', { origin: 'null', 'x-woori-request': '1' }),
  ])
    assert.throws(
      () => checkAdminOrigin(req, config),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'REQUEST_ORIGIN_REJECTED'
    );
});

test('admin session policy: MFA, re-auth window, idle sliding and lockout', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');
  const minutes = (value: number) => new Date(now.getTime() + value * 60_000);
  const pre = { mfaVerifiedAt: null, reauthAt: null };
  const verified = { mfaVerifiedAt: minutes(-5), reauthAt: minutes(-5) };
  const stale = { mfaVerifiedAt: minutes(-60), reauthAt: minutes(-11) };
  assert.equal(adminAccessError(pre, 'session', false, now), null);
  assert.equal(
    adminAccessError(pre, 'verified', false, now),
    'ADMIN_MFA_REQUIRED'
  );
  assert.equal(
    adminAccessError(pre, 'session', true, now),
    'ADMIN_MFA_REQUIRED'
  );
  assert.equal(adminAccessError(verified, 'verified', true, now), null);
  assert.equal(adminAccessError(stale, 'verified', false, now), null);
  assert.equal(
    adminAccessError(stale, 'verified', true, now),
    'ADMIN_REAUTH_REQUIRED'
  );
  assert.deepEqual(reauthValidUntil(minutes(-5), now), minutes(5));
  assert.equal(reauthValidUntil(minutes(-10), now), null);
  assert.equal(reauthValidUntil(null, now), null);

  const session = {
    mfaVerifiedAt: minutes(-10),
    idleExpiresAt: minutes(29.5),
    expiresAt: minutes(400),
  };
  // Written at most once per minute; pre-MFA sessions never slide.
  assert.equal(nextIdleExpiry(session, now), null);
  assert.deepEqual(
    nextIdleExpiry({ ...session, idleExpiresAt: minutes(28) }, now),
    minutes(30)
  );
  assert.equal(
    nextIdleExpiry(
      { ...session, mfaVerifiedAt: null, idleExpiresAt: minutes(1) },
      now
    ),
    null
  );
  // Never beyond the absolute expiry.
  assert.deepEqual(
    nextIdleExpiry(
      { ...session, idleExpiresAt: minutes(5), expiresAt: minutes(10) },
      now
    ),
    minutes(10)
  );

  let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const next = nextFailureState(state, now);
    assert.equal(next.locked, false);
    assert.equal(next.failedLoginCount, attempt);
    state = next;
  }
  const fifth = nextFailureState(state, now);
  assert.equal(fifth.locked, true);
  assert.equal(fifth.lockedUntil!.getTime(), now.getTime() + ADMIN_LOCKOUT_MS);
  // After the lock expires a new series starts.
  const later = new Date(now.getTime() + ADMIN_LOCKOUT_MS + 1);
  assert.deepEqual(nextFailureState(fifth, later), {
    failedLoginCount: 1,
    lockedUntil: null,
    locked: false,
  });
});

test('admin configuration is optional but fails fast when set incorrectly', () => {
  const key = randomBytes(32).toString('base64');
  const origins = 'https://app.example.test,https://admin.example.test';
  assert.equal(adminConfig({}), null);
  assert.equal(
    adminConfig({
      ADMIN_WEB_ORIGIN: 'https://admin.example.test',
      CORS_ALLOWED_ORIGINS: origins,
    }),
    null
  );
  assert.equal(adminConfig({ ADMIN_TOTP_ENCRYPTION_KEY: key }), null);
  assert.deepEqual(
    runtimeConfig({
      CORS_ALLOWED_ORIGINS: origins,
      ADMIN_WEB_ORIGIN: 'https://admin.example.test',
      ADMIN_TOTP_ENCRYPTION_KEY: key,
    }).admin,
    { webOrigin: 'https://admin.example.test', totpEncryptionKey: key }
  );
  for (const env of [
    // Not CORS-allowed.
    {
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
      ADMIN_WEB_ORIGIN: 'https://admin.example.test',
    },
    {
      CORS_ALLOWED_ORIGINS: origins,
      ADMIN_WEB_ORIGIN: 'https://admin.example.test/',
    },
    {
      CORS_ALLOWED_ORIGINS: origins,
      ADMIN_WEB_ORIGIN: 'ftp://admin.example.test',
    },
    { ADMIN_TOTP_ENCRYPTION_KEY: 'private-secret-value' },
    { ADMIN_TOTP_ENCRYPTION_KEY: randomBytes(16).toString('base64') },
  ]) {
    try {
      runtimeConfig(env);
      assert.fail('configuration should reject');
    } catch (error) {
      assert.match(startupFailure(error), /\[CONFIG\].*ADMIN_/);
      assert.doesNotMatch(startupFailure(error), /private-secret-value/);
    }
  }
});

test('admin audit metadata accepts only listed keys with enum, number or boolean values', () => {
  assert.deepEqual(
    adminAuditMetadata({
      stage: 'LOGIN',
      revokedSessions: 2,
      sessionRevoked: true,
    }),
    { stage: 'LOGIN', revokedSessions: 2, sessionRevoked: true }
  );
  for (const metadata of [
    { password: 'x' },
    { token: 'x' },
    { email: 'a@example.test' },
    { reason: 'free text from someone' },
    { stage: 'login' },
    { revokedSessions: 1.5 },
  ])
    assert.throws(() => adminAuditMetadata(metadata as never));
});

test('admin CLI never takes a password argument and confirms the target database', () => {
  const base = ['--username', 'Ops_Admin', '--confirm-database', 'woori_dev'];
  assert.deepEqual(
    parseAdminCliArgs(['create', ...base, '--display-name', ' 운영자 ']),
    {
      command: 'create',
      username: 'ops_admin',
      displayName: '운영자',
      confirmDatabase: 'woori_dev',
      passwordStdin: false,
    }
  );
  assert.equal(parseAdminCliArgs(['disable', ...base]).command, 'disable');
  const usage = (argv: string[]) =>
    assert.throws(
      () => parseAdminCliArgs(argv),
      (error) => error instanceof AdminCliError
    );
  usage([
    'create',
    ...base,
    '--display-name',
    '운영자',
    '--password',
    'x'.repeat(20),
  ]);
  usage([
    'create',
    ...base,
    '--display-name',
    '운영자',
    '--password=secret-value',
  ]);
  usage(['create', '--username', 'ops_admin', '--display-name', '운영자']);
  usage(['create', ...base]);
  usage(['reset-mfa', ...base, '--password-stdin']);
  usage(['drop', ...base]);
  usage(['enable', ...base, '--username', 'other']);
  assert.equal(
    targetDatabaseName('postgresql://owner:pw@127.0.0.1:55439/woori_dev'),
    'woori_dev'
  );
  assert.throws(() => targetDatabaseName(undefined));
  assert.throws(() => targetDatabaseName('https://example.test/woori'));
  assert.equal(validateAdminPassword('x'.repeat(16)), 'x'.repeat(16));
  for (const password of [
    'x'.repeat(15),
    'x'.repeat(129),
    `${'x'.repeat(16)}\n`,
  ])
    assert.throws(() => validateAdminPassword(password));
  // Error output is fixed text and never echoes driver messages.
  assert.doesNotMatch(
    adminCliErrorMessage(new Error('postgresql://owner:secret@db.invalid')),
    /secret|db\.invalid/
  );
});

test('configured admin realm: guards run without consulting member sessions or the DB', async () => {
  const saved = {
    cors: process.env.CORS_ALLOWED_ORIGINS,
    origin: process.env.ADMIN_WEB_ORIGIN,
    key: process.env.ADMIN_TOTP_ENCRYPTION_KEY,
    db: process.env.DATABASE_URL,
  };
  const member = 'https://app.example.test';
  const adminOrigin = 'https://admin.example.test';
  process.env.CORS_ALLOWED_ORIGINS = `${member},${adminOrigin}`;
  process.env.ADMIN_WEB_ORIGIN = adminOrigin;
  process.env.ADMIN_TOTP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  // No DB: a member or admin session lookup would answer 503, not 401.
  delete process.env.DATABASE_URL;
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const fabricated = `session=mock; woori_session=${'a'.repeat(43)}; woori_admin_session=mock`;
    for (const path of [
      '/v1/admin',
      '/V1/ADMIN',
      '/v1/admin/users',
      '/api/v1/admin/users',
      '/v1/admin/auth/me',
      '/v1/admin/audit-logs',
    ]) {
      const res = await api
        .get(path)
        .set('Authorization', 'Bearer unsigned.fake.token')
        .set('Cookie', fabricated)
        .expect(401);
      assert.equal(res.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    // Admin login is reachable only from the admin web origin.
    const fromMember = await api
      .post('/v1/admin/auth/login')
      .set('Origin', member)
      .set('X-Woori-Request', '1')
      .send({ username: 'ops_admin', password: 'x'.repeat(20) })
      .expect(403);
    assert.equal(fromMember.body.code, 'REQUEST_ORIGIN_REJECTED');
    await api
      .post('/v1/admin/auth/login')
      .set('Origin', adminOrigin)
      .send({ username: 'ops_admin', password: 'x'.repeat(20) })
      .expect(403);
    await api
      .post('/v1/admin/auth/login')
      .set('Origin', adminOrigin)
      .set('X-Woori-Request', '1')
      .send({ username: 'ops_admin', password: 'x'.repeat(20), role: 'x' })
      .expect(400);
    await api
      .post('/v1/admin/auth/login')
      .set('Origin', adminOrigin)
      .set('X-Woori-Request', '1')
      .send({ username: 'ops_admin', password: 'short' })
      .expect(400);
    // Logout without a valid admin cookie only expires the cookie.
    const logout = await api
      .post('/v1/admin/auth/logout')
      .set('Origin', adminOrigin)
      .set('X-Woori-Request', '1')
      .expect(204);
    assert.match(
      String(logout.headers['set-cookie']),
      /woori_admin_session=;.*SameSite=Strict/i
    );
    // CORS: admin paths are readable only by the admin web; member routes
    // keep the full allow-list.
    const adminFromMember = await api
      .options('/v1/admin/auth/login')
      .set('Origin', member)
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(
      adminFromMember.headers['access-control-allow-origin'],
      undefined
    );
    const adminFromAdmin = await api
      .options('/v1/admin/auth/login')
      .set('Origin', adminOrigin)
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(
      adminFromAdmin.headers['access-control-allow-origin'],
      adminOrigin
    );
    const memberRoute = await api.get('/healthz').set('Origin', member);
    assert.equal(memberRoute.headers['access-control-allow-origin'], member);
    // Settings are read per request: removing one closes the admin realm.
    delete process.env.ADMIN_TOTP_ENCRYPTION_KEY;
    const closed = await api.get('/v1/admin/auth/me').expect(503);
    assert.equal(closed.body.code, 'ADMIN_NOT_CONFIGURED');
  } finally {
    await app.close();
    for (const [name, value] of [
      ['CORS_ALLOWED_ORIGINS', saved.cors],
      ['ADMIN_WEB_ORIGIN', saved.origin],
      ['ADMIN_TOTP_ENCRYPTION_KEY', saved.key],
      ['DATABASE_URL', saved.db],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
