import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createECDH } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { MailService } from '../src/domain/auth/mail.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { hashToken, createToken } from '../src/domain/auth/auth-token';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
test('isolated PostgreSQL: recovery, profile and session reset boundaries', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const origin = process.env.WEB_ORIGIN!;
  const mutate = (op: Test) =>
    op.set('Origin', origin).set('X-Woori-Request', '1');
  const password = 'recovery-fixture-password-2026',
    newPassword = 'recovery-fixture-new-password-2026';
  const suffix = randomBytes(5).toString('hex');
  const account = {
    username: `recovery_${suffix}`,
    displayName: '복구 이름',
    email: `recovery_${suffix}@example.test`,
    password,
  };
  const peer = {
    ...account,
    username: `peer_${suffix}`,
    email: `peer_${suffix}@example.test`,
  };
  const mails = async () => {
    const values = [];
    for (const file of await readdir(process.env.DEV_MAIL_DIR!)) {
      const value = JSON.parse(
        await readFile(join(process.env.DEV_MAIL_DIR!, file), 'utf8')
      );
      if (value.to === account.email) values.push(value);
    }
    return values as { to: string; subject: string; text: string }[];
  };
  const resetMails = async () =>
    (await mails()).filter((m) => m.subject.includes('비밀번호'));
  const tokenIn = (mail: { text: string }) =>
    new URL(mail.text.match(/http[^\s]+/)![0]).searchParams.get('token')!;
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer()),
      owner = request.agent(app.getHttpServer()),
      other = request.agent(app.getHttpServer());
    const signup = await mutate(owner.post('/v1/auth/signup'))
      .send(account)
      .expect(201);
    const userId = signup.body.user.id;
    await mutate(other.post('/v1/auth/signup')).send(peer).expect(201);
    const requestReset = () =>
      mutate(api.post('/v1/auth/recovery/password')).send({
        name: '새 이름',
        email: account.email,
      });
    const confirm = (token: string) =>
      mutate(api.post('/v1/auth/recovery/password/confirm')).send({
        token,
        newPassword,
      });

    await t.test(
      'profile updates current account only and recovery uses the current name',
      async () => {
        await mutate(api.patch('/v1/auth/profile'))
          .send({ displayName: '새 이름' })
          .expect(401);
        await mutate(owner.patch('/v1/auth/profile'))
          .send({ displayName: '새 이름', userId: 'forged' })
          .expect(400);
        await mutate(owner.patch('/v1/auth/profile'))
          .send({ displayName: '   ' })
          .expect(400);
        const result = await mutate(owner.patch('/v1/auth/profile'))
          .send({ displayName: ' 새 이름 ' })
          .expect(200);
        assert.equal(result.body.user.displayName, '새 이름');
        assert.equal(result.body.user.passwordHash, undefined);
        assert.equal(
          (await other.get('/v1/auth/me')).body.user.displayName,
          peer.displayName
        );
        const before = (await mails()).length;
        await mutate(api.post('/v1/auth/recovery/username'))
          .send({ name: account.displayName, email: account.email })
          .expect(202, { accepted: true });
        assert.equal((await mails()).length, before);
        await mutate(api.post('/v1/auth/recovery/username'))
          .send({ name: '새 이름', email: ` ${account.email.toUpperCase()} ` })
          .expect(202, { accepted: true });
        assert.ok(
          (await mails()).some(
            (m) =>
              m.subject.includes('아이디') && m.text.includes(account.username)
          )
        );
      }
    );
    await t.test(
      'absent and suspended accounts and delivery failure share the same response',
      async () => {
        const before = (await mails()).length;
        await mutate(api.post('/v1/auth/recovery/password'))
          .send({ name: 'unknown', email: `unknown_${suffix}@example.test` })
          .expect(202, { accepted: true });
        await admin.query(
          "UPDATE woori.users SET status='SUSPENDED' WHERE id=$1",
          [userId]
        );
        await requestReset().expect(202, { accepted: true });
        await admin.query(
          "UPDATE woori.users SET status='ACTIVE' WHERE id=$1",
          [userId]
        );
        assert.equal((await mails()).length, before);
        const mail = app.get(MailService),
          original = mail.sendUsername;
        mail.sendUsername = async () => {
          throw new Error('provider fixture failure');
        };
        try {
          await mutate(api.post('/v1/auth/recovery/username'))
            .send({ name: '새 이름', email: account.email })
            .expect(202, { accepted: true });
        } finally {
          mail.sendUsername = original;
        }
      }
    );
    let resetToken = '';
    await t.test(
      'reset tokens are hashed, purpose separated and superseded by a new request',
      async () => {
        const verification = (await mails()).find((m) =>
          m.subject.includes('이메일 주소')
        )!;
        await confirm(tokenIn(verification)).expect(400);
        await requestReset().expect(202);
        const first = tokenIn((await resetMails()).at(-1)!);
        await requestReset().expect(202);
        const messages = await resetMails();
        resetToken = messages.map(tokenIn).find((value) => value !== first)!;
        assert.ok(resetToken);
        await confirm(first).expect(400);
        await mutate(owner.post('/v1/auth/email-verification/confirm'))
          .send({ token: resetToken })
          .expect(400);
        const stored = await admin.query(
          'SELECT "tokenHash", "expiresAt", "consumedAt" FROM woori.email_tokens WHERE "tokenHash"=$1',
          [hashToken(resetToken)]
        );
        assert.equal(stored.rowCount, 1);
        assert.notEqual(stored.rows[0].tokenHash, resetToken);
        assert.equal(stored.rows[0].consumedAt, null);
        assert.ok(
          new Date(stored.rows[0].expiresAt).getTime() <=
            Date.now() + 30 * 60 * 1000
        );
      }
    );
    await t.test(
      'expired tokens, unsafe origins and malformed passwords cannot change the account',
      async () => {
        await api
          .post('/v1/auth/recovery/password/confirm')
          .send({ token: resetToken, newPassword })
          .expect(403);
        await mutate(api.post('/v1/auth/recovery/password/confirm'))
          .send({ token: resetToken, newPassword: 'short' })
          .expect(400);
        const expired = createToken();
        await admin.query(
          'INSERT INTO woori.email_tokens(id,"userId","tokenHash",purpose,"expiresAt") VALUES($1::uuid,$2::uuid,$3,\'RESET_PASSWORD\',now()-interval \'1 minute\')',
          [crypto.randomUUID(), userId, hashToken(expired)]
        );
        await confirm(expired).expect(400);
        await owner.get('/v1/auth/me').expect(200);
      }
    );
    await t.test(
      'concurrent consumption succeeds once, revokes sessions and push, and fences stale login',
      async () => {
        const ecdh = createECDH('prime256v1');
        ecdh.generateKeys();
        await mutate(owner.post('/v1/push/subscriptions'))
          .send({
            endpoint: `https://fcm.googleapis.com/fcm/send/recovery-${suffix}`,
            keys: {
              p256dh: ecdh.getPublicKey().toString('base64url'),
              auth: randomBytes(16).toString('base64url'),
            },
            expirationTime: null,
          })
          .expect(201);
        const oldHash = (
          await admin.query(
            'SELECT "passwordHash" FROM woori.users WHERE id=$1',
            [userId]
          )
        ).rows[0].passwordHash;
        const responses = await Promise.all([
          confirm(resetToken),
          confirm(resetToken),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [204, 400]);
        await confirm(resetToken).expect(400);
        await owner.get('/v1/auth/me').expect(401);
        await other.get('/v1/auth/me').expect(200);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.push_installations WHERE "userId"=$1 AND enabled=true',
              [userId]
            )
          ).rows[0].n,
          0
        );
        await assert.rejects(
          app
            .get(AuthRepository)
            .createSession(userId, hashToken(createToken()), oldHash)
        );
        await mutate(api.post('/v1/auth/login'))
          .send({ username: account.username, password })
          .expect(401);
        await mutate(owner.post('/v1/auth/login'))
          .send({ username: account.username, password: newPassword })
          .expect(200);
        assert.equal(
          (await owner.get('/v1/auth/me')).body.user.emailVerified,
          false
        );
      }
    );
    await t.test(
      'rate limits apply equally to unknown email addresses',
      async () => {
        const input = {
          name: 'unknown',
          email: `limit_${suffix}@example.test`,
        };
        const first = await Promise.all(
          Array.from({ length: 5 }, () =>
            mutate(api.post('/v1/auth/recovery/username')).send(input)
          )
        );
        assert.ok(first.every((r) => r.status === 202));
        await mutate(api.post('/v1/auth/recovery/username'))
          .send(input)
          .expect(429);
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
