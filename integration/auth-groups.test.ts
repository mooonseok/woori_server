import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { hashToken, sessionCookieName } from '../src/domain/auth/auth-token';

// This suite changes data. It is intentionally impossible to run against the
// development/production DB or a remote host, even if a URL is misconfigured.
function requireIsolatedDatabase(key: string): string {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1', 'Explicit integration-test opt-in is required');
  const value = process.env[key];
  assert.ok(value, `${key} is required`);
  const url = new URL(value);
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/, 'Integration tests require a disposable woori_test database');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Integration tests must use a loopback PostgreSQL host');
  return value;
}

test('real PostgreSQL: authentication, private groups and single-use invitation concurrency', async t => {
  requireIsolatedDatabase('DATABASE_URL');
  const admin = new Pool({ connectionString: requireIsolatedDatabase('MIGRATION_DATABASE_URL'), max: 2 });
  assert.equal(process.env.MAIL_MODE, 'file', 'Integration tests never send real email');
  assert.notEqual(process.env.NODE_ENV, 'production');
  const mailDirectory = process.env.DEV_MAIL_DIR;
  assert.ok(mailDirectory, 'A private temporary outbox directory is required');
  const origin = process.env.WEB_ORIGIN;
  assert.ok(origin);
  const app = await createApp();
  const password = 'integration-only-password-2026';
  const suffix = randomBytes(5).toString('hex');
  const mutation = (operation: Test) => operation.set('Origin', origin).set('X-Woori-Request', '1');
  type Agent = ReturnType<typeof request.agent>;
  type Account = { agent: Agent; id: string; username: string; email: string; cookie: string; verificationToken: string };
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const signup = async (name: string): Promise<Account> => {
      const agent = request.agent(app.getHttpServer());
      const username = `${name}_${suffix}`;
      const email = `${username}@example.test`;
      const response = await mutation(agent.post('/v1/auth/signup')).send({ username, email, displayName: name, password }).expect(201);
      assert.equal(response.body.user.emailVerified, false);
      assert.equal(response.body.verificationDelivery, 'sent');
      assert.equal(response.body.passwordHash, undefined);
      assert.equal(response.body.user.passwordHash, undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
      const cookies = response.headers['set-cookie'] as unknown as string[];
      const header = cookies.find(value => value.startsWith(`${sessionCookieName()}=`));
      assert.ok(header, 'Signup must set the session cookie');
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Lax/i);
      const cookie = header.split(';')[0];
      let verificationToken: string | undefined;
      for (const file of await readdir(mailDirectory)) {
        if (!file.endsWith('.json')) continue;
        const path = join(mailDirectory, file);
        const mail = JSON.parse(await readFile(path, 'utf8')) as { to: string; text: string };
        if (mail.to !== email) continue;
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const link = mail.text.match(/https?:\/\/[^\s]+/);
        assert.ok(link, 'Verification mail must contain a link');
        verificationToken = new URL(link[0]).searchParams.get('token') ?? undefined;
      }
      assert.ok(verificationToken, 'Verification token must be delivered only through the private outbox');
      return { agent, id: response.body.user.id, username, email, cookie, verificationToken };
    };
    const owner = await signup('owner');
    const memberA = await signup('member_a');
    const memberB = await signup('member_b');
    const unverified = await signup('new_family');
    const verify = async (account: Account) => {
      const response = await mutation(account.agent.post('/v1/auth/email-verification/confirm')).send({ token: account.verificationToken }).expect(200);
      assert.equal(response.body.user.emailVerified, true);
    };
    await t.test('signup persists only password/session/token hashes; unverified users cannot create groups', async () => {
      const rows = await admin.query('SELECT "passwordHash" FROM woori.users WHERE id=$1', [owner.id]);
      assert.match(rows.rows[0].passwordHash, /^scrypt\$131072\$8\$1\$/);
      const rawSession = owner.cookie.slice(owner.cookie.indexOf('=') + 1);
      const sessions = await admin.query('SELECT "tokenHash" FROM woori.sessions WHERE "userId"=$1', [owner.id]);
      assert.equal(sessions.rows[0].tokenHash, hashToken(rawSession));
      const tokens = await admin.query('SELECT "tokenHash" FROM woori.email_tokens WHERE "userId"=$1', [owner.id]);
      assert.equal(tokens.rows[0].tokenHash, hashToken(owner.verificationToken));
      const response = await mutation(owner.agent.post('/v1/groups')).send({ name: '가족 앨범' }).expect(403);
      assert.equal(response.body.code, 'EMAIL_VERIFICATION_REQUIRED');
      await mutation(memberA.agent.post('/v1/auth/email-verification/confirm')).send({ token: owner.verificationToken }).expect(400);
      await verify(owner);
      await mutation(owner.agent.post('/v1/auth/email-verification/confirm')).send({ token: owner.verificationToken }).expect(400);
      await verify(memberA); await verify(memberB);
    });
    let groupId = '';
    let invitation: { id: string; code: string; url: string };
    await t.test('only members can read groups and only the owner can issue invitations', async () => {
      const created = await mutation(owner.agent.post('/v1/groups')).send({ name: '통합검증 가족' }).expect(201);
      groupId = created.body.group.id;
      assert.equal(created.body.group.role, 'OWNER');
      assert.equal(created.body.group.members, 1);
      const mine = await owner.agent.get('/v1/groups').expect(200);
      assert.equal(mine.body.groups.some((group: { id: string }) => group.id === groupId), true);
      assert.deepEqual((await memberA.agent.get('/v1/groups').expect(200)).body.groups, []);
      await memberA.agent.get(`/v1/groups/${groupId}`).expect(404);
      await api.get(`/v1/groups/${groupId}`).expect(401);
      await mutation(memberA.agent.post(`/v1/groups/${groupId}/invitations`)).send({ maxUses: 1 }).expect(404);
      const response = await mutation(owner.agent.post(`/v1/groups/${groupId}/invitations`)).send({ maxUses: 1 }).expect(201);
      invitation = response.body;
      assert.match(invitation.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
      const rawToken = new URL(invitation.url).searchParams.get('token');
      assert.ok(rawToken);
      const saved = await admin.query('SELECT "tokenHash", "codeHash" FROM woori.invitations WHERE id=$1', [invitation.id]);
      assert.equal(saved.rows[0].tokenHash, hashToken(rawToken));
      assert.equal(saved.rows[0].codeHash, hashToken(invitation.code));
      const preview = await mutation(api.post('/v1/invitations/preview')).send({ token: rawToken }).expect(200);
      assert.deepEqual(Object.keys(preview.body).sort(), ['expiresAt', 'groupName']);
      const listed = await owner.agent.get(`/v1/groups/${groupId}/invitations`).expect(200);
      assert.equal(listed.body.invitations[0].code, undefined);
      assert.equal(listed.body.invitations[0].tokenHash, undefined);
      await mutation(unverified.agent.post('/v1/invitations/join')).send({ code: invitation.code }).expect(403);
    });
    let winner: Account;
    let loser: Account;
    await t.test('concurrent joins cannot exceed maxUses and the successful join is idempotent', async () => {
      const outcomes = await Promise.all([memberA, memberB].map(account => mutation(account.agent.post('/v1/invitations/join')).send({ code: invitation.code })));
      assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 410]);
      winner = outcomes[0].status === 200 ? memberA : memberB;
      loser = winner === memberA ? memberB : memberA;
      const repeat = await mutation(winner.agent.post('/v1/invitations/join')).send({ code: invitation.code }).expect(200);
      assert.equal(repeat.body.alreadyMember, true);
      const count = await admin.query('SELECT "useCount" FROM woori.invitations WHERE id=$1', [invitation.id]);
      assert.equal(count.rows[0].useCount, 1);
      await winner.agent.get(`/v1/groups/${groupId}`).expect(200);
      await loser.agent.get(`/v1/groups/${groupId}`).expect(404);
      await mutation(winner.agent.post(`/v1/groups/${groupId}/invitations`)).send({}).expect(404);
      await winner.agent.get(`/v1/groups/${groupId}/invitations`).expect(404);
      await mutation(winner.agent.delete(`/v1/groups/${groupId}/invitations/${invitation.id}`)).expect(404);
    });
    await t.test('revoked and expired invitations fail; removed membership cannot rejoin', async () => {
      const make = async () => (await mutation(owner.agent.post(`/v1/groups/${groupId}/invitations`)).send({ maxUses: 10 }).expect(201)).body;
      const revoked = await make();
      await mutation(owner.agent.delete(`/v1/groups/${groupId}/invitations/${revoked.id}`)).expect(204);
      await mutation(loser.agent.post('/v1/invitations/join')).send({ code: revoked.code }).expect(410);
      await mutation(api.post('/v1/invitations/preview')).send({ code: revoked.code }).expect(410);
      const expired = await make();
      await admin.query('UPDATE woori.invitations SET "expiresAt" = now() - interval \'1 second\' WHERE id=$1', [expired.id]);
      await mutation(loser.agent.post('/v1/invitations/join')).send({ code: expired.code }).expect(410);
      const valid = await make();
      await admin.query('UPDATE woori.memberships SET status=\'REMOVED\' WHERE "groupId"=$1 AND "userId"=$2', [groupId, winner.id]);
      await winner.agent.get(`/v1/groups/${groupId}`).expect(404);
      const denied = await mutation(winner.agent.post('/v1/invitations/join')).send({ code: valid.code }).expect(403);
      assert.equal(denied.body.code, 'GROUP_JOIN_NOT_ALLOWED');
    });
    await t.test('CSRF checks reject untrusted origins and missing custom headers; user cookies cannot authorize admin', async () => {
      await owner.agent.post('/v1/groups').send({ name: '차단' }).expect(403);
      await owner.agent.post('/v1/groups').set('Origin', origin).send({ name: '차단' }).expect(403);
      await owner.agent.post('/v1/groups').set('Origin', 'https://evil.example').set('X-Woori-Request', '1').send({ name: '차단' }).expect(403);
      await owner.agent.get('/v1/admin').expect(403);
      await owner.agent.get('/V1/ADMIN').expect(403);
    });
    await t.test('expired, revoked and suspended sessions fail; login rotates and logout revokes', async () => {
      await verify(unverified);
      const login = async () => mutation(unverified.agent.post('/v1/auth/login')).send({ username: unverified.username, password }).expect(200);
      await mutation(api.post('/v1/auth/login')).send({ username: unverified.username, password: 'incorrect-password-long' }).expect(401);
      await admin.query('UPDATE woori.sessions SET "expiresAt" = now() - interval \'1 second\' WHERE "userId"=$1', [unverified.id]);
      await unverified.agent.get('/v1/auth/me').expect(401);
      await login();
      await unverified.agent.get('/v1/auth/me').expect(200);
      await admin.query('UPDATE woori.sessions SET "revokedAt" = now() WHERE "userId"=$1', [unverified.id]);
      await unverified.agent.get('/v1/auth/me').expect(401);
      await login();
      await admin.query('UPDATE woori.users SET status=\'SUSPENDED\' WHERE id=$1', [unverified.id]);
      await unverified.agent.get('/v1/auth/me').expect(401);
      await mutation(api.post('/v1/auth/login')).send({ username: unverified.username, password }).expect(401);
      await admin.query('UPDATE woori.users SET status=\'ACTIVE\' WHERE id=$1', [unverified.id]);
      const response = await login();
      const oldCookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      await login();
      await api.get('/v1/auth/me').set('Cookie', oldCookie).expect(401);
      await mutation(unverified.agent.post('/v1/auth/logout')).expect(204);
      await unverified.agent.get('/v1/auth/me').expect(401);
    });
  } finally { await app.close(); await admin.end(); }
});
