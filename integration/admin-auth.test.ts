import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { ADMIN_AUDIT_METADATA_KEYS } from '../src/admin/admin-audit';
import {
  createAdminAccount,
  resetAdminMfa,
  setAdminStatus,
} from '../src/admin/cli/admin-account-commands';
import {
  base32Decode,
  encryptTotpSecret,
  generateTotpSecret,
  totpCode,
} from '../src/admin/totp';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
const COOKIE = 'woori_admin_session';
const WINDOW = 15 * 60 * 1000;
const MINUTE = 60 * 1000;
const meKeys = [
  'admin',
  'idleExpiresAt',
  'mfa',
  'reauthValidUntil',
  'sessionExpiresAt',
];

test('isolated PostgreSQL: separate admin authentication, TOTP MFA, sessions and audit', async (t) => {
  isolated('DATABASE_URL');
  const ownerUrl = isolated('MIGRATION_DATABASE_URL');
  const owner = new Pool({ connectionString: ownerUrl, max: 2 });
  const adminOrigin = process.env.ADMIN_WEB_ORIGIN!;
  const memberOrigin = process.env.WEB_ORIGIN!;
  const totpKey = process.env.ADMIN_TOTP_ENCRYPTION_KEY!;
  assert.ok(adminOrigin && memberOrigin && totpKey);
  assert.notEqual(adminOrigin, memberOrigin);
  const app = await createApp();
  const suffix = randomBytes(3).toString('hex');
  const password = `admin-integration-pass-${suffix}`;
  const secretsSeen = new Set<string>([password]);
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const adminMutation = (op: Test) =>
      op.set('Origin', adminOrigin).set('X-Woori-Request', '1');
    // Every admin request (GET included) carries the custom CSRF header.
    const adminGet = (path: string) =>
      api.get(path).set('X-Woori-Request', '1');
    const as = (op: Test, token: string) =>
      op.set('Cookie', `${COOKIE}=${token}`);
    const setCookie = (res: Response) =>
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((value) => value.startsWith(`${COOKIE}=`));
    const tokenOf = (res: Response) => {
      const match = /^woori_admin_session=([A-Za-z0-9_-]{43});/.exec(
        setCookie(res) ?? ''
      );
      assert.ok(match, 'admin session cookie issued');
      secretsSeen.add(match[1]);
      return match[1];
    };
    const query = async (sql: string, values: unknown[] = []) =>
      (await owner.query(sql, values)).rows;
    const account = async (id: string) =>
      (
        await query(
          'SELECT status,"totpSecretCiphertext","totpEnabledAt","totpLastUsedStep","failedLoginCount","lockedUntil","lastLoginAt" FROM woori.admin_accounts WHERE id=$1',
          [id]
        )
      )[0];
    const sessionOf = async (token: string) =>
      (
        await query('SELECT * FROM woori.admin_sessions WHERE "tokenHash"=$1', [
          hashToken(token),
        ])
      )[0];
    const audits = async (adminId: string, action?: string) =>
      query(
        `SELECT * FROM woori.admin_audit_logs WHERE "adminId"=$1 ${action ? 'AND action=$2' : ''} ORDER BY "createdAt",id`,
        action ? [adminId, action] : [adminId]
      );
    // A 6-digit code outside the current ±1 step window.
    const badCode = (secret: Buffer) => {
      const now = Date.now();
      const window = new Set(
        [-1, 0, 1].map((step) => totpCode(secret, now + step * 30_000))
      );
      let value = Number(totpCode(secret, now));
      let candidate: string;
      do {
        value = (value + 1) % 1_000_000;
        candidate = String(value).padStart(6, '0');
      } while (window.has(candidate));
      return candidate;
    };
    // Each scenario stays within the per-IP admin limits; the explicit limit
    // test seeds buckets instead of issuing dozens of scrypt logins.
    const ipKeys = (scope: string) =>
      ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
        (ip) => rateLimitKey('auth', `${scope}:${ip}`, new Date(), WINDOW).id
      );
    const resetIpLimits = () =>
      owner.query('DELETE FROM woori.rate_limit_buckets WHERE id = ANY($1)', [
        [...ipKeys('admin-login-ip'), ...ipKeys('admin-mfa-ip')],
      ]);
    // CLI-equivalent creation through the owner connection.
    const createAdmin = async (label: string) => {
      const client = await owner.connect();
      try {
        const created = await createAdminAccount(client, {
          username: `${label}_${suffix}`,
          displayName: `운영자 ${label}`,
          password,
        });
        return { ...created, displayName: `운영자 ${label}` };
      } finally {
        client.release();
      }
    };
    // Simulates a completed enrolment for scenarios that do not test setup.
    const enrol = async (adminId: string) => {
      const secret = generateTotpSecret();
      await owner.query(
        'UPDATE woori.admin_accounts SET "totpSecretCiphertext"=$2,"totpEnabledAt"=now(),"totpLastUsedStep"=NULL WHERE id=$1',
        [adminId, encryptTotpSecret(secret, totpKey, adminId)]
      );
      return secret;
    };
    // Lets the next code at the current step be used (simulates time passing).
    const forgetStep = (adminId: string) =>
      owner.query(
        'UPDATE woori.admin_accounts SET "totpLastUsedStep"=NULL WHERE id=$1',
        [adminId]
      );
    const login = (username: string, pass = password, previous?: string) => {
      const op = adminMutation(api.post('/v1/admin/auth/login'));
      if (previous) as(op, previous);
      return op.send({ username, password: pass });
    };
    const verified = async (admin: { id: string; username: string }) => {
      const secret = await enrol(admin.id);
      const pre = tokenOf(await login(admin.username).expect(200));
      const res = await as(
        adminMutation(api.post('/v1/admin/auth/mfa/verify')),
        pre
      )
        .send({ code: totpCode(secret, Date.now()) })
        .expect(200);
      return { token: tokenOf(res), secret };
    };

    await t.test(
      'migration enables RLS and the runtime role has least privilege on admin tables',
      async () => {
        const rls = await query(
          "SELECT c.relname, c.relrowsecurity, EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='woori' AND p.tablename=c.relname AND p.policyname='server_api_access') AS policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='woori' AND c.relname IN ('admin_accounts','admin_sessions','admin_audit_logs') ORDER BY c.relname"
        );
        assert.deepEqual(rls, [
          { relname: 'admin_accounts', relrowsecurity: true, policy: true },
          { relname: 'admin_audit_logs', relrowsecurity: true, policy: true },
          { relname: 'admin_sessions', relrowsecurity: true, policy: true },
        ]);
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = async (table: string) =>
            (
              await runtime.query(
                `SELECT has_table_privilege(current_user, $1, 'SELECT') AS read, has_table_privilege(current_user, $1, 'INSERT') AS insert, has_table_privilege(current_user, $1, 'UPDATE') AS update, has_table_privilege(current_user, $1, 'DELETE') AS delete, has_table_privilege(current_user, $1, 'TRUNCATE') AS truncate`,
                [`woori.${table}`]
              )
            ).rows[0];
          assert.deepEqual(await privileges('admin_accounts'), {
            read: true,
            insert: false,
            update: false,
            delete: false,
            truncate: false,
          });
          // Column-scoped UPDATE: no table-wide UPDATE privilege.
          assert.deepEqual(await privileges('admin_sessions'), {
            read: true,
            insert: true,
            update: false,
            delete: false,
            truncate: false,
          });
          const sessionColumns = (
            await runtime.query(
              "SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid='woori.admin_sessions'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user, 'woori.admin_sessions', a.attname, 'UPDATE') ORDER BY a.attname"
            )
          ).rows.map((row: { name: string }) => row.name);
          assert.deepEqual(sessionColumns, [
            'expiresAt',
            'idleExpiresAt',
            'mfaFailedCount',
            'mfaVerifiedAt',
            'reauthAt',
            'revokedAt',
            'tokenHash',
          ]);
          assert.deepEqual(await privileges('admin_audit_logs'), {
            read: true,
            insert: true,
            update: false,
            delete: false,
            truncate: false,
          });
          const columns = (
            await runtime.query(
              "SELECT a.attname AS name, has_column_privilege(current_user, 'woori.admin_accounts', a.attname, 'UPDATE') AS update FROM pg_attribute a WHERE a.attrelid='woori.admin_accounts'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname"
            )
          ).rows as Array<{ name: string; update: boolean }>;
          assert.deepEqual(
            columns.filter((column) => column.update).map((c) => c.name),
            [
              'failedLoginCount',
              'lastLoginAt',
              'lockedUntil',
              'totpEnabledAt',
              'totpLastUsedStep',
              'totpSecretCiphertext',
            ]
          );
          const denied = (error: { code?: string }) => error.code === '42501';
          await assert.rejects(
            runtime.query(
              "INSERT INTO woori.admin_accounts (id,username,\"displayName\",\"passwordHash\") VALUES (gen_random_uuid(),'runtime_admin','x','x')"
            ),
            denied
          );
          for (const sql of [
            "UPDATE woori.admin_accounts SET status='ACTIVE'",
            'UPDATE woori.admin_accounts SET "passwordHash"=\'x\'',
            "UPDATE woori.admin_accounts SET username='x'",
            'DELETE FROM woori.admin_accounts',
            "UPDATE woori.admin_audit_logs SET action='ADMIN_TAMPERED'",
            'DELETE FROM woori.admin_audit_logs',
            'TRUNCATE woori.admin_audit_logs',
            'DELETE FROM woori.admin_sessions',
            `UPDATE woori.admin_sessions SET "adminId"='${randomUUID()}'`,
            'UPDATE woori.admin_sessions SET "createdAt"=now()',
            `UPDATE woori.admin_sessions SET id='${randomUUID()}'`,
          ])
            await assert.rejects(runtime.query(sql), denied, sql);
        } finally {
          await runtime.end();
        }
      }
    );

    await t.test(
      'the CLI uses the owner connection, confirms the database and prints no secrets',
      async () => {
        const database = new URL(ownerUrl).pathname.slice(1);
        const username = `cli_${suffix}`;
        const run = (args: string[], input?: string) =>
          spawnSync(process.execPath, ['scripts/admin-accounts.mjs', ...args], {
            env: process.env,
            input,
            encoding: 'utf8',
          });
        const createArgs = (confirm: string) => [
          'create',
          '--username',
          username,
          '--display-name',
          'CLI 운영자',
          '--confirm-database',
          confirm,
          '--password-stdin',
        ];
        const count = async () =>
          (
            await query(
              'SELECT count(*)::int AS n FROM woori.admin_accounts WHERE username=$1',
              [username]
            )
          )[0].n;
        const mismatch = run(createArgs('woori_dev'), `${password}\n`);
        assert.equal(mismatch.status, 1);
        assert.match(mismatch.stderr, /--confirm-database/);
        const argvPassword = run([
          ...createArgs(database).slice(0, -1),
          '--password',
          password,
        ]);
        assert.equal(argvPassword.status, 1);
        const short = run(createArgs(database), 'too-short\n');
        assert.equal(short.status, 1);
        const multiline = run(createArgs(database), `${password}\nsecond\n`);
        assert.equal(multiline.status, 1);
        assert.equal(await count(), 0);
        const created = run(createArgs(database), `${password}\n`);
        assert.equal(created.status, 0, created.stderr);
        const output = JSON.parse(created.stdout);
        assert.deepEqual(Object.keys(output).sort(), ['id', 'username']);
        assert.equal(output.username, username);
        for (const result of [mismatch, argvPassword, short, created])
          assert.doesNotMatch(
            `${result.stdout}${result.stderr}`,
            new RegExp(`${password}|postgres(ql)?://`)
          );
        const row = (
          await query(
            'SELECT "passwordHash",status,"displayName" FROM woori.admin_accounts WHERE id=$1',
            [output.id]
          )
        )[0];
        assert.match(row.passwordHash, /^scrypt\$131072\$8\$1\$/);
        assert.equal(row.status, 'ACTIVE');
        assert.equal(row.displayName, 'CLI 운영자');
        assert.equal(
          (await audits(output.id, 'ADMIN_CREATED_BY_CLI')).length,
          1
        );
        const duplicate = run(createArgs(database), `${password}\n`);
        assert.equal(duplicate.status, 1);
        assert.match(duplicate.stderr, /이미 사용 중/);
        const reset = run([
          'reset-mfa',
          '--username',
          username,
          '--confirm-database',
          database,
        ]);
        assert.equal(reset.status, 0, reset.stderr);
        assert.equal(JSON.parse(reset.stdout).revokedSessions, 0);
        assert.equal(
          (await audits(output.id, 'ADMIN_MFA_RESET_BY_CLI')).length,
          1
        );
      }
    );

    await t.test(
      'login failures are generic, audited without the attempted name and the session starts pre-MFA',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('login');
        const unknown = await login(`nobody_${suffix}`).expect(401);
        const wrong = await login(admin.username, `${password}-wrong`).expect(
          401
        );
        assert.equal(unknown.body.code, 'ADMIN_INVALID_CREDENTIALS');
        assert.deepEqual(wrong.body, unknown.body);
        assert.equal(setCookie(wrong), undefined);
        const unknownRows = await query(
          `SELECT metadata FROM woori.admin_audit_logs WHERE "adminId" IS NULL AND action='ADMIN_LOGIN_FAILED'`
        );
        assert.ok(unknownRows.length >= 1);
        assert.doesNotMatch(JSON.stringify(unknownRows), /nobody_/);
        assert.deepEqual(unknownRows.at(-1).metadata, {
          stage: 'LOGIN',
          reason: 'UNKNOWN_ACCOUNT',
        });
        assert.deepEqual(
          (await audits(admin.id, 'ADMIN_LOGIN_FAILED')).map((r) => r.metadata),
          [{ stage: 'LOGIN', reason: 'WRONG_PASSWORD' }]
        );
        assert.equal((await account(admin.id)).failedLoginCount, 1);
        // The member web origin cannot even attempt an admin login.
        const memberOriginLogin = await api
          .post('/v1/admin/auth/login')
          .set('Origin', memberOrigin)
          .set('X-Woori-Request', '1')
          .send({ username: admin.username, password })
          .expect(403);
        assert.equal(memberOriginLogin.body.code, 'REQUEST_ORIGIN_REJECTED');

        const ok = await login(admin.username).expect(200);
        assert.deepEqual(ok.body, {
          admin: {
            id: admin.id,
            username: admin.username,
            displayName: admin.displayName,
          },
          mfa: 'SETUP_REQUIRED',
        });
        const cookie = setCookie(ok)!;
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Strict/i);
        assert.match(cookie, /Path=\//);
        assert.match(cookie, /Max-Age=600\b/);
        const token = tokenOf(ok);
        const stored = await sessionOf(token);
        assert.ok(stored, 'only the token hash is stored');
        assert.equal(
          (
            await query(
              'SELECT count(*)::int AS n FROM woori.admin_sessions WHERE "tokenHash"=$1',
              [token]
            )
          )[0].n,
          0
        );
        assert.equal(stored.mfaVerifiedAt, null);
        assert.ok(
          Math.abs(stored.expiresAt.getTime() - Date.now() - 10 * MINUTE) <
            MINUTE
        );
        // A successful password does not reset the failure series (MFA does).
        assert.equal((await account(admin.id)).failedLoginCount, 1);
        assert.equal((await account(admin.id)).lastLoginAt, null);

        const me = await as(adminGet('/v1/admin/auth/me'), token).expect(200);
        assert.deepEqual(Object.keys(me.body).sort(), meKeys);
        assert.equal(me.body.mfa, 'SETUP_REQUIRED');
        assert.equal(me.body.reauthValidUntil, null);
        // Pre-MFA sessions reach only me, MFA and logout.
        for (const op of [
          as(adminGet('/v1/admin/audit-logs'), token),
          as(adminGet('/v1/admin/users'), token),
          as(adminMutation(api.post('/v1/admin/auth/reauth')), token).send({
            password,
            code: '123456',
          }),
        ]) {
          const res = await op.expect(403);
          assert.equal(res.body.code, 'ADMIN_MFA_REQUIRED');
        }
        for (const path of ['verify', 'activate']) {
          const res = await as(
            adminMutation(api.post(`/v1/admin/auth/mfa/${path}`)),
            token
          )
            .send({ code: '123456' })
            .expect(409);
          assert.equal(res.body.code, 'ADMIN_MFA_SETUP_REQUIRED');
        }
        // Logging in again with the old cookie rotates (revokes) it.
        const again = await login(admin.username, password, token).expect(200);
        const rotated = tokenOf(again);
        assert.notEqual(rotated, token);
        assert.ok((await sessionOf(token)).revokedAt);
        const stale = await as(adminGet('/v1/admin/auth/me'), token).expect(
          401
        );
        assert.equal(stale.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        await as(adminGet('/v1/admin/auth/me'), rotated).expect(200);
        // A disabled admin gets the same generic answer.
        const client = await owner.connect();
        try {
          await setAdminStatus(client, admin.username, 'DISABLED');
        } finally {
          client.release();
        }
        assert.deepEqual(
          (await login(admin.username).expect(401)).body,
          unknown.body
        );
        await as(adminGet('/v1/admin/auth/me'), rotated).expect(401);
      }
    );

    let enrolled: { id: string; username: string; secret: Buffer } | undefined;
    let verifiedToken = '';
    await t.test(
      'MFA setup, activation, verification, replay rejection and token rotation',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('mfa');
        const pre = tokenOf(await login(admin.username).expect(200));
        const setup = async () =>
          (
            await as(adminMutation(api.post('/v1/admin/auth/mfa/setup')), pre)
              .send({})
              .expect(200)
          ).body as { secret: string; otpauthUri: string };
        const first = await setup();
        assert.deepEqual(Object.keys(first).sort(), ['otpauthUri', 'secret']);
        assert.match(first.secret, /^[A-Z2-7]{32}$/);
        assert.ok(
          first.otpauthUri.startsWith(
            `otpauth://totp/${encodeURIComponent('우리 관리자')}:${admin.username}?secret=${first.secret}&issuer=${encodeURIComponent('우리 관리자')}`
          )
        );
        const second = await setup();
        assert.notEqual(second.secret, first.secret);
        secretsSeen.add(first.secret).add(second.secret);
        const stored = await account(admin.id);
        assert.ok(stored.totpSecretCiphertext);
        assert.equal(stored.totpEnabledAt, null);
        assert.doesNotMatch(
          stored.totpSecretCiphertext,
          new RegExp(second.secret)
        );
        const secret = base32Decode(second.secret);
        // The replaced pending secret no longer works.
        const oldCode = totpCode(base32Decode(first.secret), Date.now());
        if (oldCode !== totpCode(secret, Date.now())) {
          const replaced = await as(
            adminMutation(api.post('/v1/admin/auth/mfa/activate')),
            pre
          )
            .send({ code: oldCode })
            .expect(401);
          assert.equal(replaced.body.code, 'ADMIN_MFA_INVALID');
        }
        const failures = (await account(admin.id)).failedLoginCount;
        assert.ok(failures <= 1);
        const code = totpCode(secret, Date.now());
        const activated = await as(
          adminMutation(api.post('/v1/admin/auth/mfa/activate')),
          pre
        )
          .send({ code })
          .expect(200);
        assert.deepEqual(Object.keys(activated.body).sort(), meKeys);
        assert.equal(activated.body.mfa, 'VERIFIED');
        assert.ok(
          Math.abs(
            Date.parse(activated.body.reauthValidUntil) -
              Date.now() -
              10 * MINUTE
          ) < MINUTE
        );
        assert.ok(
          Math.abs(
            Date.parse(activated.body.sessionExpiresAt) -
              Date.now() -
              8 * 60 * MINUTE
          ) < MINUTE
        );
        assert.ok(
          Math.abs(
            Date.parse(activated.body.idleExpiresAt) - Date.now() - 30 * MINUTE
          ) < MINUTE
        );
        // Privilege elevation rotates the token; the pre-MFA token is dead.
        assert.match(setCookie(activated)!, /Max-Age=28800\b/);
        const token = tokenOf(activated);
        assert.notEqual(token, pre);
        await as(adminGet('/v1/admin/auth/me'), pre).expect(401);
        const after = await account(admin.id);
        assert.ok(after.totpEnabledAt);
        assert.ok(after.lastLoginAt);
        assert.equal(after.failedLoginCount, 0);
        assert.equal(after.lockedUntil, null);
        assert.equal(
          (await audits(admin.id, 'ADMIN_MFA_ENABLED')).length,
          1,
          'activation audited'
        );
        assert.deepEqual(
          (await audits(admin.id, 'ADMIN_LOGIN_SUCCEEDED')).map(
            (row) => row.metadata
          ),
          [{ method: 'TOTP_SETUP' }]
        );
        for (const path of ['setup', 'activate', 'verify']) {
          const res = await as(
            adminMutation(api.post(`/v1/admin/auth/mfa/${path}`)),
            token
          )
            .send(path === 'setup' ? {} : { code })
            .expect(409);
          assert.equal(res.body.code, 'ADMIN_MFA_ALREADY_VERIFIED');
        }

        // Next login: TOTP is required, setup/activate are closed.
        const next = tokenOf(await login(admin.username).expect(200));
        const me = await as(adminGet('/v1/admin/auth/me'), next).expect(200);
        assert.equal(me.body.mfa, 'REQUIRED');
        for (const path of ['setup', 'activate']) {
          const res = await as(
            adminMutation(api.post(`/v1/admin/auth/mfa/${path}`)),
            next
          )
            .send(path === 'setup' ? {} : { code })
            .expect(409);
          assert.equal(res.body.code, 'ADMIN_MFA_ALREADY_ENABLED');
        }
        // The code already used for activation is a replay.
        const replay = await as(
          adminMutation(api.post('/v1/admin/auth/mfa/verify')),
          next
        )
          .send({ code })
          .expect(401);
        assert.equal(replay.body.code, 'ADMIN_MFA_INVALID');
        await forgetStep(admin.id);
        const ok = await as(
          adminMutation(api.post('/v1/admin/auth/mfa/verify')),
          next
        )
          .send({ code: totpCode(secret, Date.now()) })
          .expect(200);
        assert.equal(ok.body.mfa, 'VERIFIED');
        verifiedToken = tokenOf(ok);
        assert.deepEqual(
          (await audits(admin.id, 'ADMIN_LOGIN_SUCCEEDED')).map(
            (row) => row.metadata
          ),
          [{ method: 'TOTP_SETUP' }, { method: 'TOTP' }]
        );
        assert.equal((await account(admin.id)).failedLoginCount, 0);
        enrolled = { id: admin.id, username: admin.username, secret };
        // Verified sessions can read the audit log; unknown admin paths 404.
        await as(adminGet('/v1/admin/audit-logs'), verifiedToken).expect(200);
        // (users became a real admin route in W06 slice C.)
        for (const path of [
          '/v1/admin/no-such-feature',
          '/api/v1/admin/users',
        ]) {
          const missing = await as(adminGet(path), verifiedToken).expect(404);
          assert.equal(missing.body.code, 'ADMIN_NOT_FOUND', path);
        }
      }
    );

    await t.test(
      'five wrong codes end the session; five consecutive failures lock the account until expiry',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('lock');
        const secret = await enrol(admin.id);
        const wrongCode = (token: string) =>
          as(adminMutation(api.post('/v1/admin/auth/mfa/verify')), token).send({
            code: badCode(secret),
          });
        // Session limit independently of the account lockout counter.
        const pre = tokenOf(await login(admin.username).expect(200));
        for (let attempt = 1; attempt <= 4; attempt++) {
          const res = await wrongCode(pre).expect(401);
          assert.equal(res.body.code, 'ADMIN_MFA_INVALID');
        }
        await owner.query(
          'UPDATE woori.admin_accounts SET "failedLoginCount"=0 WHERE id=$1',
          [admin.id]
        );
        const fifth = await wrongCode(pre).expect(401);
        assert.equal(fifth.body.code, 'ADMIN_MFA_INVALID');
        assert.match(setCookie(fifth)!, /woori_admin_session=;/);
        const revoked = await sessionOf(pre);
        assert.ok(revoked.revokedAt);
        assert.equal(revoked.mfaFailedCount, 5);
        assert.equal((await account(admin.id)).lockedUntil, null);
        const gone = await as(adminGet('/v1/admin/auth/me'), pre).expect(401);
        assert.equal(gone.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        assert.equal(
          (await audits(admin.id, 'ADMIN_MFA_FAILED')).at(-1).metadata
            .sessionRevoked,
          true
        );

        // Account lockout: password and MFA failures form one series.
        await owner.query(
          'UPDATE woori.admin_accounts SET "failedLoginCount"=0 WHERE id=$1',
          [admin.id]
        );
        for (let attempt = 1; attempt <= 3; attempt++)
          await login(admin.username, `${password}-wrong`).expect(401);
        const second = tokenOf(await login(admin.username).expect(200));
        await wrongCode(second).expect(401);
        assert.equal((await account(admin.id)).failedLoginCount, 4);
        const locking = await wrongCode(second).expect(401);
        assert.equal(locking.body.code, 'ADMIN_MFA_INVALID');
        const locked = await account(admin.id);
        assert.ok(
          Math.abs(locked.lockedUntil.getTime() - Date.now() - 15 * MINUTE) <
            MINUTE
        );
        assert.ok((await sessionOf(second)).revokedAt);
        assert.deepEqual(
          (await audits(admin.id, 'ADMIN_LOCKED')).map((r) => r.metadata),
          [{ stage: 'VERIFY' }]
        );
        // While locked even the correct password gets the generic answer.
        const generic = await login(admin.username).expect(401);
        assert.equal(generic.body.code, 'ADMIN_INVALID_CREDENTIALS');
        assert.equal(setCookie(generic), undefined);
        assert.equal(
          (await audits(admin.id, 'ADMIN_LOGIN_FAILED')).at(-1).metadata.reason,
          'LOCKED'
        );
        // Lock expiry (simulated) restores login and starts a new series.
        await owner.query(
          `UPDATE woori.admin_accounts SET "lockedUntil"=now()-interval '1 second' WHERE id=$1`,
          [admin.id]
        );
        const third = tokenOf(await login(admin.username).expect(200));
        await wrongCode(third).expect(401);
        const restarted = await account(admin.id);
        assert.equal(restarted.failedLoginCount, 1);
        assert.equal(restarted.lockedUntil, null);
        await forgetStep(admin.id);
        await as(adminMutation(api.post('/v1/admin/auth/mfa/verify')), third)
          .send({ code: totpCode(secret, Date.now()) })
          .expect(200);
        assert.equal((await account(admin.id)).failedLoginCount, 0);

        // Five wrong passwords lock the account as well.
        const pwd = await createAdmin('pwlock');
        for (let attempt = 1; attempt <= 5; attempt++)
          await login(pwd.username, `${password}-wrong`).expect(401);
        assert.ok((await account(pwd.id)).lockedUntil);
        assert.deepEqual(
          (await audits(pwd.id, 'ADMIN_LOCKED')).map((r) => r.metadata),
          [{ stage: 'LOGIN' }]
        );
        await login(pwd.username).expect(401);
        // CLI enable clears a lockout.
        const client = await owner.connect();
        try {
          await setAdminStatus(client, pwd.username, 'ACTIVE');
        } finally {
          client.release();
        }
        await login(pwd.username).expect(200);
      }
    );

    await t.test(
      'login rate limits apply per IP and per username',
      async () => {
        await resetIpLimits();
        const name = `limited_${suffix}`;
        for (let attempt = 1; attempt <= 10; attempt++)
          await login(name, `${password}-wrong`).expect(401);
        const limited = await login(name, `${password}-wrong`).expect(429);
        assert.equal(limited.body.code, 'TOO_MANY_REQUESTS');
        await resetIpLimits();
        // The per-IP budget (30 per 15 min) is already used up.
        const { windowStart } = rateLimitKey('auth', 'x', new Date(), WINDOW);
        for (const id of ipKeys('admin-login-ip'))
          await owner.query(
            'INSERT INTO woori.rate_limit_buckets (id,"windowStart",attempts) VALUES ($1,$2,30) ON CONFLICT(id) DO UPDATE SET attempts=30',
            [id, windowStart]
          );
        const byIp = await login(`other_${suffix}`).expect(429);
        assert.equal(byIp.body.code, 'TOO_MANY_REQUESTS');
        await resetIpLimits();
      }
    );

    await t.test(
      're-authentication window, generic failures, replay and lockout',
      async () => {
        await resetIpLimits();
        assert.ok(enrolled);
        const { id, secret } = enrolled;
        const reauth = (body: object, token = verifiedToken) =>
          as(adminMutation(api.post('/v1/admin/auth/reauth')), token).send(
            body
          );
        // A fresh MFA login counts as recent authentication; simulate 11 min.
        await owner.query(
          `UPDATE woori.admin_sessions SET "reauthAt"=now()-interval '11 minutes' WHERE "tokenHash"=$1`,
          [hashToken(verifiedToken)]
        );
        const stale = await as(
          adminGet('/v1/admin/auth/me'),
          verifiedToken
        ).expect(200);
        assert.equal(stale.body.reauthValidUntil, null);
        await forgetStep(id);
        const wrongPassword = await reauth({
          password: `${password}-wrong`,
          code: totpCode(secret, Date.now()),
        }).expect(401);
        assert.equal(wrongPassword.body.code, 'ADMIN_INVALID_CREDENTIALS');
        const wrongCode = await reauth({
          password,
          code: badCode(secret),
        }).expect(401);
        assert.deepEqual(wrongCode.body, wrongPassword.body);
        assert.equal((await account(id)).failedLoginCount, 2);
        await as(adminGet('/v1/admin/auth/me'), verifiedToken).expect(200);
        const code = totpCode(secret, Date.now());
        const ok = await reauth({ password, code }).expect(200);
        assert.ok(
          Math.abs(
            Date.parse(ok.body.reauthValidUntil) - Date.now() - 10 * MINUTE
          ) < MINUTE
        );
        assert.equal((await account(id)).failedLoginCount, 0);
        assert.deepEqual(
          (await audits(id, 'ADMIN_REAUTH_FAILED')).map(
            (row) => row.metadata.reason
          ),
          ['WRONG_PASSWORD', 'INVALID_CODE']
        );
        assert.equal((await audits(id, 'ADMIN_REAUTHENTICATED')).length, 1);
        // The same code cannot be used twice.
        await reauth({ password, code }).expect(401);
        // Reaching the lockout threshold ends this session too.
        await owner.query(
          'UPDATE woori.admin_accounts SET "failedLoginCount"=4 WHERE id=$1',
          [id]
        );
        const locking = await reauth({
          password: `${password}-wrong`,
          code: badCode(secret),
        }).expect(401);
        assert.match(setCookie(locking)!, /woori_admin_session=;/);
        assert.ok((await account(id)).lockedUntil);
        await as(adminGet('/v1/admin/auth/me'), verifiedToken).expect(401);
        assert.deepEqual(
          (await audits(id, 'ADMIN_LOCKED')).map((row) => row.metadata),
          [{ stage: 'REAUTH' }]
        );
        await owner.query(
          'UPDATE woori.admin_accounts SET "failedLoginCount"=0,"lockedUntil"=NULL WHERE id=$1',
          [id]
        );
      }
    );

    await t.test(
      'idle and absolute expiry, idle sliding and logout',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('expiry');
        const fresh = async () => (await verified(admin)).token;
        const me = (token: string) => as(adminGet('/v1/admin/auth/me'), token);
        // Idle sliding: written when at least a minute can be gained.
        const sliding = await fresh();
        await owner.query(
          `UPDATE woori.admin_sessions SET "idleExpiresAt"=now()+interval '5 minutes' WHERE "tokenHash"=$1`,
          [hashToken(sliding)]
        );
        const slid = await me(sliding).expect(200);
        const idle = (await sessionOf(sliding)).idleExpiresAt.getTime();
        assert.ok(Math.abs(idle - Date.now() - 30 * MINUTE) < MINUTE);
        assert.equal(Date.parse(slid.body.idleExpiresAt), idle);
        // Idle timeout.
        await owner.query(
          `UPDATE woori.admin_sessions SET "idleExpiresAt"=now()-interval '1 second' WHERE "tokenHash"=$1`,
          [hashToken(sliding)]
        );
        const idleOut = await me(sliding).expect(401);
        assert.equal(idleOut.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        // Absolute timeout.
        const absolute = await fresh();
        await owner.query(
          `UPDATE woori.admin_sessions SET "expiresAt"=now()-interval '1 second',"idleExpiresAt"=now()-interval '1 second' WHERE "tokenHash"=$1`,
          [hashToken(absolute)]
        );
        await me(absolute).expect(401);
        // Pre-MFA sessions end after 10 minutes.
        const pre = tokenOf(await login(admin.username).expect(200));
        await owner.query(
          `UPDATE woori.admin_sessions SET "createdAt"=now()-interval '11 minutes',"expiresAt"=now()-interval '1 minute',"idleExpiresAt"=now()-interval '1 minute' WHERE "tokenHash"=$1`,
          [hashToken(pre)]
        );
        await me(pre).expect(401);
        // Logout revokes, clears the cookie and is audited once.
        const live = await fresh();
        const out = await as(
          adminMutation(api.post('/v1/admin/auth/logout')),
          live
        )
          .send({})
          .expect(204);
        assert.match(setCookie(out)!, /woori_admin_session=;/);
        assert.ok((await sessionOf(live)).revokedAt);
        await me(live).expect(401);
        await as(adminMutation(api.post('/v1/admin/auth/logout')), live)
          .send({})
          .expect(204);
        assert.equal((await audits(admin.id, 'ADMIN_LOGGED_OUT')).length, 1);
        // Logout from the member web origin is rejected.
        await as(
          api
            .post('/v1/admin/auth/logout')
            .set('Origin', memberOrigin)
            .set('X-Woori-Request', '1'),
          await fresh()
        )
          .send({})
          .expect(403);
      }
    );

    await t.test(
      'member and admin realms never authorize each other; member origin is rejected for admin',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('realm');
        const { token } = await verified(admin);
        const memberToken = createToken();
        await app.get(AuthRepository).createUser(
          {
            username: `member_${suffix}`,
            email: `member_${suffix}@example.test`,
            displayName: '회원',
            passwordHash: await hashPassword(password),
            verifiedAt: new Date(),
          },
          hashToken(memberToken)
        );
        const member = (op: Test) =>
          op.set('Cookie', `woori_session=${memberToken}`);
        await member(api.get('/v1/auth/me')).expect(200);
        for (const op of [
          member(adminGet('/v1/admin/auth/me')),
          member(adminGet('/v1/admin/audit-logs')),
          member(adminGet('/v1/admin')),
          member(
            api
              .post('/v1/admin/auth/mfa/setup')
              .set('Origin', memberOrigin)
              .set('X-Woori-Request', '1')
          ).send({}),
        ]) {
          const res = await op.expect(401);
          assert.equal(res.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        }
        for (const path of ['/v1/auth/me', '/v1/groups', '/v1/notices']) {
          const res = await as(api.get(path), token).expect(401);
          assert.equal(res.body.code, 'AUTHENTICATION_REQUIRED');
        }
        // Both cookies at once: each realm still sees only its own session.
        const both = `woori_session=${memberToken}; ${COOKIE}=${token}`;
        const meBoth = await adminGet('/v1/admin/auth/me')
          .set('Cookie', both)
          .expect(200);
        assert.equal(meBoth.body.admin.id, admin.id);
        const memberBoth = await api
          .get('/v1/auth/me')
          .set('Cookie', both)
          .expect(200);
        assert.notEqual(memberBoth.body.user.id, admin.id);
        // An audited admin GET without X-Woori-Request is rejected even with a
        // valid session (with or without the admin web Origin).
        for (const op of [
          as(api.get('/v1/admin/auth/me'), token),
          as(api.get('/v1/admin/audit-logs').set('Origin', adminOrigin), token),
          as(api.head('/v1/admin/auth/me'), token),
        ])
          await op.expect(403);
        const noHeader = await as(
          api.get('/v1/admin/audit-logs'),
          token
        ).expect(403);
        assert.equal(noHeader.body.code, 'REQUEST_ORIGIN_REJECTED');
        await as(adminGet('/v1/admin/auth/me'), token).expect(200);
        // Per-realm origins: the admin web origin cannot mutate member routes
        // (even with a member session) and gets no CORS grant there.
        const fromAdminWeb = await member(
          api
            .post('/v1/inquiries')
            .set('Origin', adminOrigin)
            .set('X-Woori-Request', '1')
        )
          .send({ category: 'OTHER', title: '관리자 웹', body: '본문' })
          .expect(403);
        assert.equal(fromAdminWeb.body.code, 'REQUEST_ORIGIN_REJECTED');
        const memberPreflight = await api
          .options('/v1/inquiries')
          .set('Origin', adminOrigin)
          .set('Access-Control-Request-Method', 'POST');
        assert.equal(
          memberPreflight.headers['access-control-allow-origin'],
          undefined
        );
        const adminPreflight = await api
          .options('/v1/admin/auth/me')
          .set('Origin', adminOrigin)
          .set('Access-Control-Request-Method', 'GET')
          .set('Access-Control-Request-Headers', 'x-woori-request');
        assert.equal(
          adminPreflight.headers['access-control-allow-origin'],
          adminOrigin
        );
        // Valid admin session + member web origin → rejected.
        for (const op of [
          as(
            adminGet('/v1/admin/audit-logs').set('Origin', memberOrigin),
            token
          ),
          as(
            api
              .post('/v1/admin/auth/reauth')
              .set('Origin', memberOrigin)
              .set('X-Woori-Request', '1'),
            token
          ).send({ password, code: '123456' }),
          as(
            api.post('/v1/admin/auth/reauth').set('Origin', adminOrigin),
            token
          ).send({ password, code: '123456' }),
        ]) {
          const res = await op.expect(403);
          assert.equal(res.body.code, 'REQUEST_ORIGIN_REJECTED');
        }
        // Settings are read per request: a missing key closes the admin API
        // while member routes keep working.
        delete process.env.ADMIN_TOTP_ENCRYPTION_KEY;
        try {
          const closed = await as(adminGet('/v1/admin/auth/me'), token).expect(
            503
          );
          assert.equal(closed.body.code, 'ADMIN_NOT_CONFIGURED');
          await member(api.get('/v1/auth/me')).expect(200);
        } finally {
          process.env.ADMIN_TOTP_ENCRYPTION_KEY = totpKey;
        }
        await as(adminGet('/v1/admin/auth/me'), token).expect(200);
      }
    );

    await t.test(
      'audit log listing pages newest first, filters by action and never stores secrets',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('audit');
        const { token } = await verified(admin);
        const list = (qs: string) =>
          as(adminGet(`/v1/admin/audit-logs${qs}`), token);
        const total = (
          await query('SELECT count(*)::int AS n FROM woori.admin_audit_logs')
        )[0].n as number;
        const seen: string[] = [];
        let cursor: string | null = null;
        let previous: { createdAt: string; id: string } | undefined;
        do {
          const page: Response = await list(
            `?limit=7${cursor ? `&cursor=${cursor}` : ''}`
          ).expect(200);
          assert.deepEqual(Object.keys(page.body).sort(), [
            'items',
            'nextCursor',
          ]);
          for (const item of page.body.items) {
            assert.deepEqual(Object.keys(item).sort(), [
              'action',
              'admin',
              'createdAt',
              'id',
              'metadata',
              'reason',
              'targetId',
              'targetType',
            ]);
            if (item.admin)
              assert.deepEqual(Object.keys(item.admin).sort(), [
                'displayName',
                'id',
              ]);
            if (previous)
              assert.ok(
                Date.parse(item.createdAt) <= Date.parse(previous.createdAt)
              );
            previous = item;
            seen.push(item.id);
          }
          cursor = page.body.nextCursor;
        } while (cursor);
        assert.equal(seen.length, total);
        assert.equal(new Set(seen).size, total);
        const failed = await list(
          '?action=ADMIN_LOGIN_FAILED&limit=100'
        ).expect(200);
        assert.ok(failed.body.items.length > 0);
        assert.ok(
          failed.body.items.every(
            (item: { action: string }) => item.action === 'ADMIN_LOGIN_FAILED'
          )
        );
        assert.ok(
          failed.body.items.some(
            (item: { admin: unknown }) => item.admin === null
          )
        );
        const own = (
          await list('?action=ADMIN_LOGIN_SUCCEEDED&limit=100').expect(200)
        ).body.items.find(
          (item: { admin: { id: string } | null }) =>
            item.admin?.id === admin.id
        );
        assert.deepEqual(own.admin, {
          id: admin.id,
          displayName: admin.displayName,
        });
        assert.equal(own.targetType, 'ADMIN');
        assert.equal(own.targetId, admin.id);
        for (const qs of [
          `?cursor=${'00000000-0000-4000-8000-000000000000'}`,
          '?limit=0',
          '?limit=101',
          '?action=admin_login_failed',
          '?cursor=not-a-uuid',
          '?unknown=1',
        ]) {
          const res = await list(qs).expect(400);
          if (qs.startsWith('?cursor=0'))
            assert.equal(res.body.code, 'ADMIN_AUDIT_CURSOR_INVALID');
        }
        // No secret material in any stored audit row.
        const rows = await query('SELECT * FROM woori.admin_audit_logs');
        const allowed = new Set<string>(ADMIN_AUDIT_METADATA_KEYS);
        for (const row of rows)
          for (const key of Object.keys(row.metadata))
            assert.ok(allowed.has(key), `unexpected metadata key ${key}`);
        const dump = JSON.stringify(rows);
        for (const secret of secretsSeen)
          assert.ok(!dump.includes(secret), 'secret stored in audit log');
        assert.doesNotMatch(
          dump,
          /@|127\.0\.0\.1|scrypt\$|v1\.[A-Za-z0-9_-]+\./
        );
      }
    );

    await t.test(
      'CLI MFA reset, disable and enable revoke sessions and write audit rows',
      async () => {
        await resetIpLimits();
        const admin = await createAdmin('ops');
        const { token } = await verified(admin);
        const client = await owner.connect();
        try {
          const reset = await resetAdminMfa(client, admin.username);
          assert.equal(reset.revokedSessions, 1);
          await as(adminGet('/v1/admin/auth/me'), token).expect(401);
          const cleared = await account(admin.id);
          assert.equal(cleared.totpSecretCiphertext, null);
          assert.equal(cleared.totpEnabledAt, null);
          assert.equal(cleared.totpLastUsedStep, null);
          assert.equal(
            (await login(admin.username).expect(200)).body.mfa,
            'SETUP_REQUIRED'
          );
          const disabled = await setAdminStatus(
            client,
            admin.username,
            'DISABLED'
          );
          assert.equal(disabled.revokedSessions, 1);
          await login(admin.username).expect(401);
          await setAdminStatus(client, admin.username, 'ACTIVE');
          await login(admin.username).expect(200);
        } finally {
          client.release();
        }
        assert.deepEqual(
          (await audits(admin.id))
            .map((row) => row.action)
            .filter((action) => action.endsWith('_BY_CLI')),
          [
            'ADMIN_CREATED_BY_CLI',
            'ADMIN_MFA_RESET_BY_CLI',
            'ADMIN_DISABLED_BY_CLI',
            'ADMIN_ENABLED_BY_CLI',
          ]
        );
        const statusRows = await audits(admin.id, 'ADMIN_DISABLED_BY_CLI');
        assert.deepEqual(statusRows[0].metadata, {
          previousStatus: 'ACTIVE',
          status: 'DISABLED',
          revokedSessions: 1,
        });
      }
    );
  } finally {
    await app.close();
    await owner.end();
  }
});
