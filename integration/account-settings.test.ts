import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createECDH } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { MailService } from '../src/domain/auth/mail.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { RecoveryRepository } from '../src/domain/auth/recovery.repository';
import { AccountSettingsRepository } from '../src/domain/auth/account-settings.repository';
import { hashToken, createToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
test('isolated PostgreSQL: account credential changes and email ownership', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const password = 'settings-original-password-2026',
    nextPassword = 'settings-next-password-2026';
  const suffix = randomBytes(5).toString('hex');
  const account = {
    username: `settings_${suffix}`,
    displayName: '설정 테스트',
    email: `settings_${suffix}@example.test`,
    password,
  };
  const peer = {
    ...account,
    username: `settingspeer_${suffix}`,
    email: `settingspeer_${suffix}@example.test`,
  };
  const target = `changed_${suffix}@example.test`;
  const tokenMail = async (email: string) => {
    const values: { text: string; subject: string }[] = [];
    for (const name of (await readdir(process.env.DEV_MAIL_DIR!)).sort()) {
      const value = JSON.parse(
        await readFile(join(process.env.DEV_MAIL_DIR!, name), 'utf8')
      );
      if (value.to === email && value.subject.includes('새 이메일'))
        values.push(value);
    }
    return values.map((v) =>
      new URL(v.text.match(/http[^\s]+/)![0]).searchParams.get('token')!
    );
  };
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer()),
      owner = request.agent(app.getHttpServer()),
      other = request.agent(app.getHttpServer()),
      device = request.agent(app.getHttpServer());
    const signup = await mutate(owner.post('/v1/auth/signup'))
      .send(account)
      .expect(201);
    const userId = signup.body.user.id;
    const peerSignup = await mutate(other.post('/v1/auth/signup'))
      .send(peer)
      .expect(201);
    await mutate(device.post('/v1/auth/login'))
      .send({ username: account.username, password })
      .expect(200);
    const change = (currentPassword: string, newPassword = nextPassword) =>
      mutate(owner.post('/v1/auth/password/change')).send({
        currentPassword,
        newPassword,
      });
    const emailRequest = (newEmail = target) =>
      mutate(owner.post('/v1/auth/email-change/request')).send({
        currentPassword: nextPassword,
        newEmail,
      });
    const confirm = (token: string) =>
      mutate(owner.post('/v1/auth/email-change/confirm')).send({ token });
    const registerPush = async () => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      await mutate(owner.post('/v1/push/subscriptions'))
        .send({
          endpoint: `https://fcm.googleapis.com/fcm/send/settings-${randomUUID()}`,
          keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
          },
          expirationTime: null,
        })
        .expect(201);
    };
    const liveCredentials = async () =>
      (
        await admin.query(
          'SELECT (SELECT count(*)::int FROM woori.sessions WHERE "userId"=$1 AND "revokedAt" IS NULL) sessions,(SELECT count(*)::int FROM woori.push_installations WHERE "userId"=$1 AND enabled=true) pushes,(SELECT count(*)::int FROM woori.email_tokens WHERE "userId"=$1 AND "consumedAt" IS NULL) tokens',
          [userId]
        )
      ).rows[0];
    await t.test(
      'requires authenticated safe requests and correct current password without losing session',
      async () => {
        await mutate(api.post('/v1/auth/password/change'))
          .send({ currentPassword: password, newPassword: nextPassword })
          .expect(401);
        await owner
          .post('/v1/auth/password/change')
          .send({ currentPassword: password, newPassword: nextPassword })
          .expect(403);
        const wrong = await change('wrong-password-2026').expect(400);
        assert.equal(wrong.body.code, 'INVALID_CURRENT_PASSWORD');
        await owner.get('/v1/auth/me').expect(200);
        await change(password, password).expect(400);
        await change(password, 'short').expect(400);
        await mutate(owner.post('/v1/auth/password/change'))
          .send({
            currentPassword: password,
            newPassword: nextPassword,
            userId: peerSignup.body.user.id,
          })
          .expect(400);
      }
    );
    await t.test(
      'password change revokes every session, push binding and token purpose',
      async () => {
        await registerPush();
        const stale = await admin.query(
          'SELECT "passwordHash" FROM woori.users WHERE id=$1',
          [userId]
        );
        const before = await admin.query(
          'SELECT "bindingVersion" FROM woori.push_installations WHERE "userId"=$1',
          [userId]
        );
        const pending = createToken();
        await admin.query(
          'INSERT INTO woori.email_tokens(id,"userId","tokenHash",purpose,"expiresAt","targetEmail") VALUES($1,$2,$3,\'CHANGE_EMAIL\',now()+interval \'30 minutes\',$4)',
          [randomUUID(), userId, hashToken(pending), target]
        );
        const result = await change(password).expect(204);
        assert.ok(
          (result.headers['set-cookie'] as unknown as string[]).some(
            (v: string) => v.includes('Expires=Thu, 01 Jan 1970')
          )
        );
        await device.get('/v1/auth/me').expect(401);
        await owner.get('/v1/auth/me').expect(401);
        await other.get('/v1/auth/me').expect(200);
        assert.deepEqual(await liveCredentials(), {
          sessions: 0,
          pushes: 0,
          tokens: 0,
        });
        const after = await admin.query(
          'SELECT "bindingVersion" FROM woori.push_installations WHERE "userId"=$1',
          [userId]
        );
        assert.equal(
          after.rows[0].bindingVersion,
          before.rows[0].bindingVersion + 1
        );
        await assert.rejects(
          app
            .get(AuthRepository)
            .createSession(
              userId,
              hashToken(createToken()),
              stale.rows[0].passwordHash,
              account.email
            )
        );
        await mutate(api.post('/v1/auth/login'))
          .send({ username: account.username, password })
          .expect(401);
        await mutate(owner.post('/v1/auth/login'))
          .send({ username: account.username, password: nextPassword })
          .expect(200);
        await confirm(pending).expect(400);
      }
    );
    let currentToken = '';
    await t.test(
      'email requests keep old address; only latest target-bound hashed token works',
      async () => {
        await emailRequest(account.email).expect(400);
        await emailRequest(peer.email).expect(409);
        await emailRequest().expect(202, { accepted: true });
        const first = (await tokenMail(target)).at(-1)!;
        await emailRequest().expect(202);
        currentToken = (await tokenMail(target)).find((v) => v !== first)!;
        assert.ok(currentToken);
        assert.equal(
          (await owner.get('/v1/auth/me')).body.user.email,
          account.email
        );
        await confirm(first).expect(400);
        await mutate(other.post('/v1/auth/email-change/confirm'))
          .send({ token: currentToken })
          .expect(400);
        await mutate(api.post('/v1/auth/email-change/confirm'))
          .send({ token: currentToken })
          .expect(401);
        await mutate(owner.post('/v1/auth/email-verification/confirm'))
          .send({ token: currentToken })
          .expect(400);
        const row = (
          await admin.query(
            'SELECT "tokenHash","targetEmail","expiresAt" FROM woori.email_tokens WHERE "tokenHash"=$1',
            [hashToken(currentToken)]
          )
        ).rows[0];
        assert.equal(row.targetEmail, target);
        assert.notEqual(row.tokenHash, currentToken);
        assert.ok(
          new Date(row.expiresAt).getTime() <= Date.now() + 30 * 60 * 1000
        );
      }
    );
    await t.test(
      'confirmation atomically verifies new address and fences old verification/recovery/login',
      async () => {
        await registerPush();
        const verify = createToken(),
          reset = createToken();
        await app
          .get(AuthRepository)
          .createEmailToken(userId, hashToken(verify), account.email, {
            id: randomUUID(),
            token: verify,
          });
        await app
          .get(RecoveryRepository)
          .issue(userId, account.displayName, account.email, hashToken(reset), {
            id: randomUUID(),
            token: reset,
          });
        const oldHash = (
          await admin.query(
            'SELECT "passwordHash" FROM woori.users WHERE id=$1',
            [userId]
          )
        ).rows[0].passwordHash;
        const results = await Promise.all([
          confirm(currentToken),
          confirm(currentToken),
        ]);
        assert.equal(results.filter((r) => r.status === 204).length, 1);
        assert.ok(results.every((r) => [204, 400, 401].includes(r.status)));
        assert.deepEqual(await liveCredentials(), {
          sessions: 0,
          pushes: 0,
          tokens: 0,
        });
        await other.get('/v1/auth/me').expect(200);
        await assert.rejects(
          app
            .get(AuthRepository)
            .createSession(
              userId,
              hashToken(createToken()),
              oldHash,
              account.email
            )
        );
        assert.equal(
          await app
            .get(AuthRepository)
            .createEmailToken(userId, hashToken(createToken()), account.email, {
              id: randomUUID(),
              token: createToken(),
            }),
          false
        );
        await assert.rejects(
          app
            .get(RecoveryRepository)
            .reset(
              hashToken(reset),
              await hashPassword('reset-stale-password-2026')
            )
        );
        await mutate(owner.post('/v1/auth/login'))
          .send({ username: account.username, password: nextPassword })
          .expect(200);
        await mutate(owner.post('/v1/auth/email-verification/confirm'))
          .send({ token: verify })
          .expect(400);
        await confirm(currentToken).expect(400);
        const me = await owner.get('/v1/auth/me');
        assert.equal(me.body.user.email, target);
        assert.equal(me.body.user.emailVerified, true);
        const messages = await Promise.all(
          (await readdir(process.env.DEV_MAIL_DIR!)).map(async (n) =>
            JSON.parse(
              await readFile(join(process.env.DEV_MAIL_DIR!, n), 'utf8')
            )
          )
        );
        assert.ok(
          messages.some(
            (m) =>
              m.to === account.email &&
              m.subject === '[우리] 계정 이메일이 변경되었어요' &&
              !m.text.includes(target)
          )
        );
      }
    );
    await t.test(
      'expired token and revoked session are rejected at the transaction boundary',
      async () => {
        const expired = createToken();
        await admin.query(
          'INSERT INTO woori.email_tokens(id,"userId","tokenHash",purpose,"expiresAt","targetEmail") VALUES($1,$2,$3,\'CHANGE_EMAIL\',now()-interval \'1 minute\',$4)',
          [randomUUID(), userId, hashToken(expired), account.email]
        );
        await confirm(expired).expect(400);
        const revoked = createToken();
        await admin.query(
          'INSERT INTO woori.sessions(id,"userId","tokenHash",audience,"expiresAt","revokedAt") VALUES($1,$2,$3,\'web\',now()+interval \'1 hour\',now())',
          [randomUUID(), userId, hashToken(revoked)]
        );
        const hash = (
          await admin.query(
            'SELECT "passwordHash" FROM woori.users WHERE id=$1',
            [userId]
          )
        ).rows[0].passwordHash;
        await assert.rejects(
          app
            .get(AccountSettingsRepository)
            .requestEmail(
              userId,
              hashToken(revoked),
              hash,
              account.email,
              hashToken(createToken()),
              { id: randomUUID(), token: createToken() }
            )
        );
        await assert.rejects(
          app
            .get(AccountSettingsRepository)
            .changePassword(userId, hashToken(revoked), hash, 'forbidden')
        );
      }
    );
    await t.test(
      'two accounts racing for one email have a single winner without partial revocation',
      async () => {
        const shared = `shared_${suffix}@example.test`;
        await emailRequest(shared).expect(202);
        const ownerToken = (await tokenMail(shared)).at(-1)!;
        await mutate(other.post('/v1/auth/email-change/request'))
          .send({ currentPassword: password, newEmail: shared })
          .expect(202);
        const otherToken = (await tokenMail(shared)).find(
          (v) => v !== ownerToken
        )!;
        const results = await Promise.all([
          confirm(ownerToken),
          mutate(other.post('/v1/auth/email-change/confirm')).send({
            token: otherToken,
          }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [204, 409]);
        const loser = results[0].status === 409 ? owner : other;
        await loser.get('/v1/auth/me').expect(200);
        const loserHash = hashToken(
          results[0].status === 409 ? ownerToken : otherToken
        );
        assert.equal(
          (
            await admin.query(
              'SELECT "consumedAt" FROM woori.email_tokens WHERE "tokenHash"=$1',
              [loserHash]
            )
          ).rows[0].consumedAt,
          null
        );
      }
    );
    await t.test(
      'password recovery also invalidates pending email changes and account credentials',
      async () => {
        const login = await mutate(other.post('/v1/auth/login'))
          .send({ username: peer.username, password })
          .expect(200);
        const currentEmail = login.body.user.email;
        const cookie = login.headers['set-cookie'][0]
          .split(';')[0]
          .split('=')[1];
        const peerId = peerSignup.body.user.id;
        const currentHash = (
          await admin.query(
            'SELECT "passwordHash" FROM woori.users WHERE id=$1',
            [peerId]
          )
        ).rows[0].passwordHash;
        const pending = createToken(),
          reset = createToken();
        await app
          .get(AccountSettingsRepository)
          .requestEmail(
            peerId,
            hashToken(cookie),
            currentHash,
            `pending_${suffix}@example.test`,
            hashToken(pending),
            { id: randomUUID(), token: pending }
          );
        await app
          .get(RecoveryRepository)
          .issue(peerId, peer.displayName, currentEmail, hashToken(reset), {
            id: randomUUID(),
            token: reset,
          });
        await app
          .get(RecoveryRepository)
          .reset(
            hashToken(reset),
            await hashPassword('peer-reset-password-2026')
          );
        await other.get('/v1/auth/me').expect(401);
        const row = (
          await admin.query(
            'SELECT "consumedAt" FROM woori.email_tokens WHERE "tokenHash"=$1',
            [hashToken(pending)]
          )
        ).rows[0];
        assert.ok(row.consumedAt);
        assert.equal(
          (
            await admin.query('SELECT email FROM woori.users WHERE id=$1', [
              peerId,
            ])
          ).rows[0].email,
          currentEmail
        );
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
