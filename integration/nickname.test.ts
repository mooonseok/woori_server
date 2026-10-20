import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { RecoveryRepository } from '../src/domain/auth/recovery.repository';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';

test('isolated PostgreSQL: public nicknames never expose recovery names and remain editable', async () => {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  const url = new URL(process.env.MIGRATION_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.equal(process.env.MAIL_MODE, 'file');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  const db = new Pool({ connectionString: url.toString() });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  try {
    await app.listen(0, '127.0.0.1');
    const signup = request(app.getHttpServer());
    const signupInput = {
      username: `nick_http_${suffix}`,
      email: `nick_http_${suffix}@example.test`,
      displayName: '가입 복구 이름',
      password: 'nickname-http-password-2026',
    };
    for (const nickname of [
      null,
      '',
      '가',
      '가족\n친구',
      '가'.repeat(21),
      '가족❤️',
    ])
      await mutate(signup.post('/v1/auth/signup'))
        .send({ ...signupInput, nickname })
        .expect(400);
    const created = await mutate(signup.post('/v1/auth/signup'))
      .send({ ...signupInput, nickname: '  가족 친구  ' })
      .expect(201);
    assert.equal(created.body.user.nickname, '가족 친구');
    assert.equal(created.body.user.displayName, signupInput.displayName);
    assert.equal(created.body.user.nicknameNeedsUpdate, false);
    // Return this fixture's shared per-IP signup budget for subsequent suites.
    await db.query(
      'UPDATE woori.rate_limit_buckets SET attempts=attempts-1 WHERE id=ANY($1) AND attempts>0',
      [
        ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
          (ip) =>
            rateLimitKey('auth', `signup-ip:${ip}`, new Date(), 60 * 60_000).id
        ),
      ]
    );
    const repository = app.get(AuthRepository);
    const passwordHash = await hashPassword('nickname-fixture-password-2026');
    const make = async (key: string, nickname?: string) => {
      const token = createToken();
      const user = await repository.createUser(
        {
          username: `nick_${key}_${suffix}`,
          email: `nick_${key}_${suffix}@example.test`,
          displayName: `비공개실명_${key}`,
          ...(nickname ? { nickname, nicknameNeedsUpdate: false } : {}),
          passwordHash,
          verifiedAt: new Date(),
        },
        hashToken(token)
      );
      const agent = request.agent(app.getHttpServer());
      agent.set('Cookie', `woori_session=${token}`);
      return { user, agent };
    };
    const owner = await make('owner', '하늘 가족');
    const peer = await make('peer', '하늘 가족'); // duplicate nicknames are intentional
    const outsider = await make('outsider');
    assert.match(outsider.user.nickname, /^회원_[a-f0-9]{8}$/);
    assert.equal(outsider.user.nicknameNeedsUpdate, true);
    const groupId = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '별명 테스트' })
        .expect(201)
    ).body.group.id;
    const invitation = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ expiresInHours: 24, maxUses: 4 })
        .expect(201)
    ).body;
    await mutate(peer.agent.post('/v1/invitations/join'))
      .send({ code: invitation.code })
      .expect(200);
    const albumId = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '닉네임 앨범' })
        .expect(201)
    ).body.album.id;
    const photoId = randomUUID();
    await db.query(
      'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) VALUES($1,$2,$3,$4,\'READY\',1,1,1)',
      [photoId, groupId, albumId, owner.user.id]
    );
    await mutate(owner.agent.post(`/v1/photos/${photoId}/comments`))
      .send({ body: '닉네임 댓글', kind: 'GENERAL' })
      .expect(201);
    const peerPhotoId = randomUUID();
    await db.query(
      'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) VALUES($1,$2,$3,$4,\'READY\',1,1,1)',
      [peerPhotoId, groupId, albumId, peer.user.id]
    );
    await mutate(owner.agent.post(`/v1/photos/${peerPhotoId}/comments`))
      .send({ body: '알림 댓글', kind: 'GENERAL' })
      .expect(201);
    await mutate(owner.agent.patch('/v1/auth/profile'))
      .send({ nickname: '  새별명  ' })
      .expect(200);
    assert.equal(
      (await owner.agent.get('/v1/auth/me').expect(200)).body.user.displayName,
      owner.user.displayName
    );
    const roster = (
      await peer.agent.get(`/v1/groups/${groupId}/members`).expect(200)
    ).body;
    assert.equal(
      roster.members.find((m: { userId: string }) => m.userId === owner.user.id)
        .nickname,
      '새별명'
    );
    const comments = (
      await peer.agent.get(`/v1/photos/${photoId}/comments`).expect(200)
    ).body;
    assert.deepEqual(comments.comments[0].author, {
      id: owner.user.id,
      nickname: '새별명',
      displayName: '새별명',
    });
    const photos = (
      await peer.agent
        .get(`/v1/groups/${groupId}/albums/${albumId}/photos`)
        .expect(200)
    ).body;
    assert.deepEqual(
      photos.photos.find((p: { id: string }) => p.id === photoId).uploader,
      {
        id: owner.user.id,
        nickname: '새별명',
        displayName: '새별명',
      }
    );
    const notifications = (
      await peer.agent.get('/v1/notifications').expect(200)
    ).body;
    assert.ok(
      notifications.notifications.some(
        (n: { actor: { nickname: string } }) => n.actor.nickname === '새별명'
      )
    );
    for (const body of [roster, comments, photos, notifications])
      assert.doesNotMatch(JSON.stringify(body), /비공개실명/);
    await outsider.agent.get(`/v1/groups/${groupId}/members`).expect(404);
    await outsider.agent.get(`/v1/photos/${photoId}/comments`).expect(404);
    await mutate(peer.agent.patch('/v1/auth/profile'))
      .send({ nickname: '위조 별명', userId: owner.user.id })
      .expect(400);
    const recovery = app.get(RecoveryRepository);
    assert.equal(
      (await recovery.findAccount(owner.user.displayName, owner.user.email))
        ?.id,
      owner.user.id
    );
    assert.equal(await recovery.findAccount('새별명', owner.user.email), null);
    const updated = (
      await mutate(outsider.agent.patch('/v1/auth/profile'))
        .send({ nickname: '새별명' })
        .expect(200)
    ).body.user;
    assert.equal(updated.nicknameNeedsUpdate, false);
  } finally {
    await app.close();
    await db.end();
  }
});

test('isolated PostgreSQL: additive nickname upgrade backfills existing accounts without publishing recovery names', async () => {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env.MIGRATION_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  const db = new Pool({ connectionString: url.toString() });
  const tx = await db.connect();
  const activeId = randomUUID(),
    deletedId = randomUUID(),
    chosenId = randomUUID();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='5s'");
    await tx.query("SET LOCAL statement_timeout='10s'");
    // Recreate the pre-upgrade shape only inside this rollback-only transaction.
    // No existing local or production database passes the environment guards.
    await tx.query(
      'ALTER TABLE woori.users DROP COLUMN nickname, DROP COLUMN "nicknameNeedsUpdate"'
    );
    await tx.query(
      `INSERT INTO woori.users (id,username,"displayName",email,"passwordHash",status) VALUES
      ($1,$2,'기존 복구 이름',$3,'synthetic-hash','ACTIVE'),
      ($4,$5,'탈퇴한 회원',$6,'','DELETED')`,
      [
        activeId,
        `upgrade_${activeId}`,
        `upgrade_${activeId}@example.test`,
        deletedId,
        `deleted_${deletedId}`,
        `deleted_${deletedId}@deleted.invalid`,
      ]
    );
    await tx.query(
      await readFile(
        'prisma/migrations/20261101000000_member_nickname/migration.sql',
        'utf8'
      )
    );
    const result = await tx.query(
      'SELECT id,"displayName",nickname,"nicknameNeedsUpdate" FROM woori.users WHERE id=ANY($1::uuid[])',
      [[activeId, deletedId, chosenId]]
    );
    const active = result.rows.find((row) => row.id === activeId);
    assert.equal(active.displayName, '기존 복구 이름');
    assert.equal(
      active.nickname,
      `가족_${activeId.replaceAll('-', '').slice(0, 8)}`
    );
    assert.equal(active.nicknameNeedsUpdate, true);
    const deleted = result.rows.find((row) => row.id === deletedId);
    assert.equal(deleted.displayName, '탈퇴한 회원');
    assert.equal(deleted.nickname, '탈퇴한 회원');
    assert.equal(deleted.nicknameNeedsUpdate, false);
    // Follow-up copy migration changes generated values, never chosen nicknames.
    await tx.query(
      `INSERT INTO woori.users (id,username,"displayName",email,"passwordHash",nickname,"nicknameNeedsUpdate")
       VALUES ($1,$2,'선택한 이름',$3,'synthetic-hash','가족_abcdef12',false)`,
      [chosenId, `chosen_${chosenId}`, `chosen_${chosenId}@example.test`]
    );
    await tx.query(
      await readFile(
        'prisma/migrations/20261102000000_neutral_member_copy/migration.sql',
        'utf8'
      )
    );
    const neutral = (
      await tx.query(
        'SELECT id,nickname,"nicknameNeedsUpdate","displayName" FROM woori.users WHERE id=ANY($1::uuid[])',
        [[activeId, deletedId, chosenId]]
      )
    ).rows;
    assert.equal(
      neutral.find((row) => row.id === activeId).nickname,
      `회원_${activeId.replaceAll('-', '').slice(0, 8)}`
    );
    assert.equal(
      neutral.find((row) => row.id === activeId).displayName,
      '기존 복구 이름'
    );
    assert.equal(
      neutral.find((row) => row.id === activeId).nicknameNeedsUpdate,
      true
    );
    assert.equal(
      neutral.find((row) => row.id === chosenId).nickname,
      '가족_abcdef12'
    );
    assert.equal(
      neutral.find((row) => row.id === chosenId).nicknameNeedsUpdate,
      false
    );
    assert.equal(
      neutral.find((row) => row.id === deletedId).nickname,
      '탈퇴한 회원'
    );
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
    // The test must leave the original schema and no upgrade fixture rows.
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM woori.users WHERE id=ANY($1::uuid[])',
          [[activeId, deletedId, chosenId]]
        )
      ).rows[0].count,
      0
    );
    await db.end();
  }
});
