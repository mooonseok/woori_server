import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import { AccountDeletionRepository } from '../src/domain/auth/account-deletion.repository';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';
import { ADMIN_AUDIT_METADATA_KEYS } from '../src/admin/admin-audit';
import { createAdminAccount } from '../src/admin/cli/admin-account-commands';
import {
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
type Agent = ReturnType<typeof request.agent>;
const COOKIE = 'woori_admin_session';
const MINUTE = 60_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('isolated PostgreSQL: admin notices, inquiries, reports and audited content views', async (t) => {
  isolated('DATABASE_URL');
  const owner = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
    max: 3,
  });
  const adminOrigin = process.env.ADMIN_WEB_ORIGIN!;
  const memberOrigin = process.env.WEB_ORIGIN!;
  const totpKey = process.env.ADMIN_TOTP_ENCRYPTION_KEY!;
  const app = await createApp();
  const suffix = randomBytes(3).toString('hex');
  const password = `content-ops-pass-${suffix}`;
  const publishedNotices = new Set<string>();
  let albumIdForCleanup: string | null = null;
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const query = async (sql: string, values: unknown[] = []) =>
      (await owner.query(sql, values)).rows;
    const memberMutation = (op: Test) =>
      op.set('Origin', memberOrigin).set('X-Woori-Request', '1');
    const adminMutation = (op: Test) =>
      op.set('Origin', adminOrigin).set('X-Woori-Request', '1');
    const as = (op: Test, token: string) =>
      op.set('Cookie', `${COOKIE}=${token}`);
    const tokenOf = (res: Response) => {
      const header = ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((value) => value.startsWith(`${COOKIE}=`));
      const match = /^woori_admin_session=([A-Za-z0-9_-]{43});/.exec(
        header ?? ''
      );
      assert.ok(match);
      return match[1];
    };
    // Earlier admin suites in this run share the per-IP admin login budget.
    await owner.query(
      'DELETE FROM woori.rate_limit_buckets WHERE id = ANY($1)',
      [
        ['127.0.0.1', '::ffff:127.0.0.1', '::1'].flatMap((ip) =>
          ['admin-login-ip', 'admin-mfa-ip'].map(
            (scope) =>
              rateLimitKey('auth', `${scope}:${ip}`, new Date(), 15 * MINUTE).id
          )
        ),
      ]
    );

    // Fake private storage: records every object read (never the original).
    const storage = app.get(MediaStorageService);
    const reads: string[] = [];
    let failReads = false;
    Object.assign(storage, {
      enabled: () => true,
      read: async (key: string) => {
        reads.push(key);
        if (failReads)
          throw new ServiceUnavailableException({
            code: 'MEDIA_STORAGE_UNAVAILABLE',
          });
        const data = Buffer.from(`webp-bytes:${key}`);
        return {
          body: Readable.from([data]),
          contentType: 'image/webp',
          byteSize: data.length,
        };
      },
    });

    // Admin: CLI-equivalent creation, simulated enrolment, password + TOTP login.
    const adminClient = await owner.connect();
    const admin = await createAdminAccount(adminClient, {
      username: `content_${suffix}`,
      displayName: '콘텐츠 운영자',
      password,
    }).finally(() => adminClient.release());
    const secret = generateTotpSecret();
    await owner.query(
      'UPDATE woori.admin_accounts SET "totpSecretCiphertext"=$2,"totpEnabledAt"=now() WHERE id=$1',
      [admin.id, encryptTotpSecret(secret, totpKey, admin.id)]
    );
    const forgetStep = () =>
      owner.query(
        'UPDATE woori.admin_accounts SET "totpLastUsedStep"=NULL WHERE id=$1',
        [admin.id]
      );
    const preMfa = tokenOf(
      await adminMutation(api.post('/v1/admin/auth/login'))
        .send({ username: admin.username, password })
        .expect(200)
    );
    const pending = tokenOf(
      await adminMutation(api.post('/v1/admin/auth/login'))
        .send({ username: admin.username, password })
        .expect(200)
    );
    const token = tokenOf(
      await as(adminMutation(api.post('/v1/admin/auth/mfa/verify')), preMfa)
        .send({ code: totpCode(secret, Date.now()) })
        .expect(200)
    );
    const get = (path: string) =>
      as(api.get(path).set('X-Woori-Request', '1'), token);
    const post = (path: string) => as(adminMutation(api.post(path)), token);
    const patch = (path: string) => as(adminMutation(api.patch(path)), token);
    const staleReauth = () =>
      owner.query(
        `UPDATE woori.admin_sessions SET "reauthAt"=now()-interval '11 minutes' WHERE "tokenHash"=$1`,
        [hashToken(token)]
      );
    const reauthenticate = async () => {
      await forgetStep();
      await post('/v1/admin/auth/reauth')
        .send({ password, code: totpCode(secret, Date.now()) })
        .expect(200);
    };
    const audits = (action: string, targetId?: string) =>
      query(
        `SELECT * FROM woori.admin_audit_logs WHERE action=$1 ${targetId ? 'AND "targetId"=$2' : ''} ORDER BY "createdAt",id`,
        targetId ? [action, targetId] : [action]
      );

    // Members, one group, one album; photos are inserted as READY fixtures.
    const fixtureHash = await hashPassword(password);
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const sessionToken = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: `${label}_${suffix}`,
          email: `${label}_${suffix}@example.test`,
          displayName: label,
          passwordHash: fixtureHash,
          verifiedAt: new Date(),
        },
        hashToken(sessionToken)
      );
      agent.set('Cookie', `woori_session=${sessionToken}`);
      return {
        agent,
        id: user.id,
        username: `${label}_${suffix}`,
        sessionHash: hashToken(sessionToken),
      };
    };
    const groupOwner = await signup('co_owner'),
      uploader = await signup('co_uploader'),
      commenter = await signup('co_commenter'),
      r1 = await signup('co_reporter1'),
      r2 = await signup('co_reporter2'),
      r3 = await signup('co_reporter3'),
      target = await signup('co_target'),
      withdrawn = await signup('co_withdrawn');
    const groupId = (
      await memberMutation(groupOwner.agent.post('/v1/groups'))
        .send({ name: '운영 테스트' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await memberMutation(
        groupOwner.agent.post(`/v1/groups/${groupId}/invitations`)
      )
        .send({ maxUses: 20 })
        .expect(201)
    ).body;
    for (const member of [uploader, commenter, r1, r2, r3, target, withdrawn])
      await app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, member.id);
    const albumTitle = '운영 앨범';
    const albumId = (
      await memberMutation(
        groupOwner.agent.post(`/v1/groups/${groupId}/albums`)
      )
        .send({ title: albumTitle })
        .expect(201)
    ).body.album.id as string;
    albumIdForCleanup = albumId;
    const album = `/v1/groups/${groupId}/albums/${albumId}`;
    const PHOTO_BYTES = 1000;
    const keysOf = (photoId: string) => {
      const prefix = `photos/${photoId}/${randomUUID()}`;
      return {
        display: `${prefix}/display.webp`,
        original: `${prefix}/original.png`,
        thumbnail: `${prefix}/thumbnail.webp`,
      };
    };
    const photoKeys = new Map<string, ReturnType<typeof keysOf>>();
    const photo = async (uploaderId: string, display = true) => {
      const id = randomUUID();
      const keys = keysOf(id);
      photoKeys.set(id, keys);
      await owner.query(
        'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height) VALUES($1,$2,$3,$4,\'READY\',$5,1,1)',
        [id, groupId, albumId, uploaderId, PHOTO_BYTES]
      );
      for (const [kind, key, mime] of [
        ['original', keys.original, 'image/png'],
        ['thumbnail', keys.thumbnail, 'image/webp'],
        ...(display ? [['preview', keys.display, 'image/webp']] : []),
      ])
        await owner.query(
          'INSERT INTO woori.photo_variants(id,"photoId",kind,"objectKey",mime,bytes,width,height) VALUES($1,$2,$3,$4,$5,100,1,1)',
          [randomUUID(), id, kind, key, mime]
        );
      await owner.query(
        'UPDATE woori.groups SET "usedBytes"="usedBytes"+$2 WHERE id=$1',
        [groupId, PHOTO_BYTES]
      );
      return id;
    };
    const comment = async (author: { agent: Agent }, photoId: string) =>
      (
        await memberMutation(
          author.agent.post(`/v1/photos/${photoId}/comments`)
        )
          .send({ body: `신고될 댓글 본문 ${suffix}` })
          .expect(201)
      ).body.comment.id as string;
    const report = async (
      reporter: { agent: Agent },
      body: Record<string, unknown>
    ) =>
      (
        await memberMutation(reporter.agent.post('/v1/reports'))
          .send({ reason: 'INAPPROPRIATE', ...body })
          .expect(201)
      ).body.id as string;
    const reportRow = async (id: string) =>
      (
        await query(
          'SELECT status::text AS status,resolution,"resolvedAt" FROM woori.content_reports WHERE id=$1',
          [id]
        )
      )[0];
    const usedBytes = async () =>
      BigInt(
        (
          await query('SELECT "usedBytes" FROM woori.groups WHERE id=$1', [
            groupId,
          ])
        )[0].usedBytes
      );
    const memberPhotoIds = async (agent: Agent) =>
      (await agent.get(`${album}/photos`).expect(200)).body.photos.map(
        (item: { id: string }) => item.id
      );

    await t.test(
      'every new route needs an MFA-verified admin session and the admin web origin',
      async () => {
        const id = randomUUID();
        const routes: Array<['get' | 'post' | 'patch', string, object?]> = [
          ['get', '/v1/admin/notices'],
          ['post', '/v1/admin/notices', { title: '제목', body: '본문' }],
          ['get', `/v1/admin/notices/${id}`],
          ['patch', `/v1/admin/notices/${id}`, { title: '제목' }],
          ['post', `/v1/admin/notices/${id}/publish`, {}],
          ['post', `/v1/admin/notices/${id}/archive`, {}],
          ['get', '/v1/admin/inquiries'],
          ['get', `/v1/admin/inquiries/${id}`],
          ['post', `/v1/admin/inquiries/${id}/answer`, { answer: '답변' }],
          ['post', `/v1/admin/inquiries/${id}/status`, { status: 'CLOSED' }],
          ['get', '/v1/admin/reports'],
          ['get', `/v1/admin/reports/${id}`],
          ['post', `/v1/admin/reports/${id}/review`, {}],
          ['post', `/v1/admin/reports/${id}/dismiss`, { reason: '사유' }],
          [
            'post',
            `/v1/admin/reports/${id}/resolve`,
            { action: 'SUSPEND_USER', reason: '사유' },
          ],
          ['post', `/v1/admin/photos/${id}/view`, { reason: '확인 사유' }],
          ['post', `/v1/admin/comments/${id}/view`, { reason: '확인 사유' }],
        ];
        for (const [method, path, body] of routes) {
          const send = (op: Test) => (body ? op.send(body) : op);
          const asMember = await send(
            method === 'get'
              ? groupOwner.agent.get(path)
              : memberMutation(groupOwner.agent[method](path))
          ).expect(401);
          assert.equal(
            asMember.body.code,
            'ADMIN_AUTHENTICATION_REQUIRED',
            path
          );
          const asPending = await send(
            as(
              method === 'get'
                ? api.get(path).set('X-Woori-Request', '1')
                : adminMutation(api[method](path)),
              pending
            )
          ).expect(403);
          assert.equal(asPending.body.code, 'ADMIN_MFA_REQUIRED', path);
          const fromMemberWeb = await send(
            as(
              (method === 'get' ? api.get(path) : api[method](path))
                .set('Origin', memberOrigin)
                .set('X-Woori-Request', '1'),
              token
            )
          ).expect(403);
          assert.equal(
            fromMemberWeb.body.code,
            'REQUEST_ORIGIN_REJECTED',
            path
          );
        }
      }
    );

    await t.test(
      'notices: drafts, scheduling, edits and archive control member visibility',
      async () => {
        const member = (id: string) => commenter.agent.get(`/v1/notices/${id}`);
        const created = await post('/v1/admin/notices')
          .send({ title: `  공지 ${suffix}  `, body: '첫 줄\n\t둘째 줄' })
          .expect(201);
        assert.deepEqual(Object.keys(created.body).sort(), [
          'body',
          'createdAt',
          'id',
          'publishedAt',
          'status',
          'title',
          'updatedAt',
        ]);
        assert.equal(created.body.title, `공지 ${suffix}`);
        assert.equal(created.body.body, '첫 줄\n\t둘째 줄');
        assert.equal(created.body.status, 'DRAFT');
        assert.equal(created.body.publishedAt, null);
        const id = created.body.id as string;
        for (const body of [
          { title: 'x'.repeat(121), body: '본문' },
          { title: '   ', body: '본문' },
          { title: '제목\n둘째', body: '본문' },
          { title: '제목‮', body: '본문' },
          { title: '제목', body: 'x'.repeat(10_001) },
          { title: '제목', body: '본문\u0007' },
          { title: '제목', body: '본문', status: 'PUBLISHED' },
        ])
          await post('/v1/admin/notices').send(body).expect(400);
        assert.equal(
          (await member(id).expect(404)).body.code,
          'NOTICE_NOT_FOUND'
        );
        const drafts = await get('/v1/admin/notices?status=DRAFT').expect(200);
        const listed = drafts.body.items.find(
          (item: { id: string }) => item.id === id
        );
        assert.deepEqual(Object.keys(listed).sort(), [
          'createdAt',
          'id',
          'publishedAt',
          'scheduled',
          'status',
          'title',
          'updatedAt',
        ]);
        assert.equal(listed.scheduled, false);
        const empty = await patch(`/v1/admin/notices/${id}`)
          .send({})
          .expect(400);
        assert.equal(empty.body.code, 'ADMIN_NOTICE_UPDATE_EMPTY');
        await patch(`/v1/admin/notices/${id}`).send({ title: '' }).expect(400);
        const now = Date.now();
        for (const publishAt of [
          new Date(now + 91 * 24 * 60 * MINUTE).toISOString(),
          new Date(now - 2 * MINUTE).toISOString(),
        ]) {
          const res = await post(`/v1/admin/notices/${id}/publish`)
            .send({ publishAt })
            .expect(400);
          assert.equal(res.body.code, 'ADMIN_NOTICE_PUBLISH_AT_INVALID');
        }
        await post(`/v1/admin/notices/${id}/publish`)
          .send({ publishAt: '2026-10-15T10:00:00' })
          .expect(400);
        const published = await post(`/v1/admin/notices/${id}/publish`)
          .send({})
          .expect(200);
        publishedNotices.add(id);
        assert.equal(published.body.status, 'PUBLISHED');
        assert.ok(
          Math.abs(Date.parse(published.body.publishedAt) - Date.now()) < MINUTE
        );
        const visible = await member(id).expect(200);
        assert.equal(visible.body.title, `공지 ${suffix}`);
        // Editing a published notice updates updatedAt, shown to members.
        await wait(5);
        const edited = await patch(`/v1/admin/notices/${id}`)
          .send({ body: '수정된 본문' })
          .expect(200);
        assert.equal(edited.body.title, `공지 ${suffix}`);
        const after = await member(id).expect(200);
        assert.equal(after.body.body, '수정된 본문');
        assert.ok(
          Date.parse(after.body.updatedAt) > Date.parse(visible.body.updatedAt)
        );
        // Scheduled: hidden until its time (simulated by moving publishedAt).
        const scheduledId = (
          await post('/v1/admin/notices')
            .send({ title: `예약 공지 ${suffix}`, body: '예약' })
            .expect(201)
        ).body.id as string;
        await post(`/v1/admin/notices/${scheduledId}/publish`)
          .send({
            publishAt: new Date(Date.now() + 24 * 60 * MINUTE).toISOString(),
          })
          .expect(200);
        publishedNotices.add(scheduledId);
        await member(scheduledId).expect(404);
        const scheduled = (
          await get('/v1/admin/notices?status=PUBLISHED&limit=50').expect(200)
        ).body.items.find((item: { id: string }) => item.id === scheduledId);
        assert.equal(scheduled.scheduled, true);
        await owner.query(
          `UPDATE woori.notices SET "publishedAt"=now()-interval '1 minute' WHERE id=$1`,
          [scheduledId]
        );
        await member(scheduledId).expect(200);
        // Archive hides; archiving again is a no-op; publishing again restores.
        const archived = await post(`/v1/admin/notices/${id}/archive`)
          .send({})
          .expect(200);
        assert.equal(archived.body.status, 'ARCHIVED');
        await member(id).expect(404);
        await post(`/v1/admin/notices/${id}/archive`).send({}).expect(200);
        await post(`/v1/admin/notices/${id}/archive`)
          .send({ force: true })
          .expect(400);
        await post(`/v1/admin/notices/${id}/publish`).send({}).expect(200);
        await member(id).expect(200);
        // Leave no published notice behind for later member-list suites.
        for (const notice of publishedNotices)
          await post(`/v1/admin/notices/${notice}/archive`)
            .send({})
            .expect(200);
        await member(id).expect(404);
        await member(scheduledId).expect(404);
        const missing = await get(`/v1/admin/notices/${randomUUID()}`).expect(
          404
        );
        assert.equal(missing.body.code, 'ADMIN_NOTICE_NOT_FOUND');
        await patch(`/v1/admin/notices/${randomUUID()}`)
          .send({ title: '없음' })
          .expect(404);
        const cursor = await get(
          `/v1/admin/notices?cursor=${randomUUID()}`
        ).expect(400);
        assert.equal(cursor.body.code, 'ADMIN_NOTICE_CURSOR_INVALID');
        // Newest-updated first, every page once.
        const seen: string[] = [];
        let next: string | null = null;
        let previous = Infinity;
        do {
          const page: Response = await get(
            `/v1/admin/notices?limit=1${next ? `&cursor=${next}` : ''}`
          ).expect(200);
          for (const item of page.body.items) {
            assert.ok(Date.parse(item.updatedAt) <= previous);
            previous = Date.parse(item.updatedAt);
            seen.push(item.id);
          }
          next = page.body.nextCursor;
        } while (next);
        assert.equal(new Set(seen).size, seen.length);
        assert.ok(seen.includes(id) && seen.includes(scheduledId));
        const actions = (
          await query(
            `SELECT action,metadata FROM woori.admin_audit_logs WHERE "targetId"=$1 ORDER BY "createdAt",id`,
            [id]
          )
        ).map((row) => [row.action, row.metadata.status]);
        assert.deepEqual(actions, [
          ['ADMIN_NOTICE_CREATED', 'DRAFT'],
          ['ADMIN_NOTICE_PUBLISHED', 'PUBLISHED'],
          ['ADMIN_NOTICE_UPDATED', 'PUBLISHED'],
          ['ADMIN_NOTICE_ARCHIVED', 'ARCHIVED'],
          ['ADMIN_NOTICE_PUBLISHED', 'PUBLISHED'],
          ['ADMIN_NOTICE_ARCHIVED', 'ARCHIVED'],
        ]);
      }
    );

    await t.test(
      'inquiries: triage list, audited detail, answers the member sees and concurrent erasure',
      async () => {
        const created = await memberMutation(
          commenter.agent.post('/v1/inquiries')
        )
          .send({
            category: 'BUG',
            title: `문의 ${suffix}`,
            body: '문의 본문입니다',
          })
          .expect(201);
        const id = created.body.id as string;
        const list = await get(
          '/v1/admin/inquiries?status=RECEIVED&category=BUG&limit=50'
        ).expect(200);
        const item = list.body.items.find(
          (entry: { id: string }) => entry.id === id
        );
        assert.deepEqual(Object.keys(item).sort(), [
          'answeredAt',
          'category',
          'createdAt',
          'id',
          'member',
          'status',
          'title',
        ]);
        assert.deepEqual(item.member, {
          id: commenter.id,
          displayName: 'co_commenter',
          username: commenter.username,
        });
        assert.ok(
          !(
            await get('/v1/admin/inquiries?category=ACCOUNT&limit=50').expect(
              200
            )
          ).body.items.some((entry: { id: string }) => entry.id === id)
        );
        await get('/v1/admin/inquiries?status=OPEN').expect(400);
        const detail = await get(`/v1/admin/inquiries/${id}`).expect(200);
        assert.equal(detail.body.body, '문의 본문입니다');
        assert.deepEqual(detail.body.member, {
          id: commenter.id,
          displayName: 'co_commenter',
          username: commenter.username,
          status: 'ACTIVE',
        });
        assert.equal((await audits('ADMIN_INQUIRY_VIEWED', id)).length, 1);
        await post(`/v1/admin/inquiries/${id}/answer`)
          .send({ answer: ' ' })
          .expect(400);
        const answered = await post(`/v1/admin/inquiries/${id}/answer`)
          .send({ answer: '확인했어요.\n곧 고칠게요.' })
          .expect(200);
        assert.equal(answered.body.status, 'ANSWERED');
        assert.ok(answered.body.answeredAt);
        const mine = await commenter.agent
          .get(`/v1/inquiries/${id}`)
          .expect(200);
        assert.equal(mine.body.status, 'ANSWERED');
        assert.equal(mine.body.answer, '확인했어요.\n곧 고칠게요.');
        await post(`/v1/admin/inquiries/${id}/answer`)
          .send({ answer: '다시 답변' })
          .expect(200);
        assert.equal(
          (await commenter.agent.get(`/v1/inquiries/${id}`).expect(200)).body
            .answer,
          '다시 답변'
        );
        await post(`/v1/admin/inquiries/${id}/status`)
          .send({ status: 'ANSWERED' })
          .expect(400);
        const closed = await post(`/v1/admin/inquiries/${id}/status`)
          .send({ status: 'CLOSED' })
          .expect(200);
        assert.equal(closed.body.status, 'CLOSED');
        // The same status changes nothing but discloses the inquiry: one VIEWED
        // row and no further STATUS_CHANGED row.
        const viewsBefore = (await audits('ADMIN_INQUIRY_VIEWED', id)).length;
        await post(`/v1/admin/inquiries/${id}/status`)
          .send({ status: 'CLOSED' })
          .expect(200);
        assert.equal(
          (await audits('ADMIN_INQUIRY_VIEWED', id)).length,
          viewsBefore + 1
        );
        assert.deepEqual(
          (await audits('ADMIN_INQUIRY_STATUS_CHANGED', id)).map(
            (row) => row.metadata
          ),
          [
            {
              userId: commenter.id,
              previousStatus: 'ANSWERED',
              status: 'CLOSED',
            },
          ]
        );
        assert.equal((await audits('ADMIN_INQUIRY_ANSWERED', id)).length, 2);
        assert.equal(
          (await get(`/v1/admin/inquiries/${randomUUID()}`).expect(404)).body
            .code,
          'ADMIN_INQUIRY_NOT_FOUND'
        );

        // Erasure committing while the answer waits for the row lock → 404.
        const racing = (
          await memberMutation(withdrawn.agent.post('/v1/inquiries'))
            .send({ category: 'OTHER', title: '탈퇴 전 문의', body: '본문' })
            .expect(201)
        ).body.id as string;
        const eraser = await owner.connect();
        try {
          await eraser.query('BEGIN');
          await eraser.query('DELETE FROM woori.inquiries WHERE id=$1', [
            racing,
          ]);
          const answer = post(`/v1/admin/inquiries/${racing}/answer`)
            .send({ answer: '늦은 답변' })
            .then((res) => res);
          for (let i = 0; i < 40; i++) {
            const waiting = await query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"
            );
            if (waiting[0].n > 0) break;
            await wait(50);
          }
          await eraser.query('COMMIT');
          const res = await answer;
          assert.equal(res.status, 404);
          assert.equal(res.body.code, 'ADMIN_INQUIRY_NOT_FOUND');
        } finally {
          eraser.release();
        }
        // Real account deletion erases the member's inquiries.
        const kept = (
          await memberMutation(withdrawn.agent.post('/v1/inquiries'))
            .send({ category: 'ACCOUNT', title: '탈퇴 문의', body: '본문' })
            .expect(201)
        ).body.id as string;
        await app
          .get(AccountDeletionRepository)
          .delete(withdrawn.id, withdrawn.sessionHash, fixtureHash);
        await get(`/v1/admin/inquiries/${kept}`).expect(404);
        await post(`/v1/admin/inquiries/${kept}/status`)
          .send({ status: 'CLOSED' })
          .expect(404);
        const stale = await get(`/v1/admin/inquiries?cursor=${kept}`).expect(
          400
        );
        assert.equal(stale.body.code, 'ADMIN_INQUIRY_CURSOR_INVALID');
      }
    );

    // Reported content.
    const pReported = await photo(uploader.id);
    const pAlready = await photo(uploader.id);
    const pTarget = await photo(target.id);
    const pNoDisplay = await photo(uploader.id, false);
    const cReported = await comment(commenter, pTarget);
    const cTarget = await comment(target, pReported);
    const rPhoto1 = await report(r1, {
      targetType: 'PHOTO',
      targetId: pReported,
      detail: '부적절한 사진',
    });
    const rPhoto2 = await report(r2, {
      targetType: 'PHOTO',
      targetId: pReported,
    });
    const rComment = await report(r1, {
      targetType: 'COMMENT',
      targetId: cReported,
    });
    const rUser1 = await report(r3, {
      targetType: 'USER',
      targetId: target.id,
      groupId,
    });
    const rUser2 = await report(r1, {
      targetType: 'USER',
      targetId: target.id,
      groupId,
    });
    const rAlready = await report(r2, {
      targetType: 'PHOTO',
      targetId: pAlready,
    });
    const rTargetPhoto = await report(r3, {
      targetType: 'PHOTO',
      targetId: pTarget,
    });
    const rDismiss = await report(r3, {
      targetType: 'COMMENT',
      targetId: cTarget,
      detail: '욕설',
    });

    await t.test(
      'reports: open queue order, filters, audited detail and review/dismiss transitions',
      async () => {
        const open = await get('/v1/admin/reports?limit=50').expect(200);
        const ids = open.body.items.map((item: { id: string }) => item.id);
        const ours = ids.filter((id: string) =>
          [
            rPhoto1,
            rPhoto2,
            rComment,
            rUser1,
            rUser2,
            rAlready,
            rTargetPhoto,
            rDismiss,
          ].includes(id)
        );
        // Oldest open report first.
        assert.deepEqual(ours, [
          rPhoto1,
          rPhoto2,
          rComment,
          rUser1,
          rUser2,
          rAlready,
          rTargetPhoto,
          rDismiss,
        ]);
        const first = open.body.items.find(
          (item: { id: string }) => item.id === rPhoto1
        );
        assert.deepEqual(Object.keys(first).sort(), [
          'createdAt',
          'group',
          'id',
          'openReportsOnTarget',
          'reason',
          'reporter',
          'resolution',
          'resolvedAt',
          'status',
          'targetType',
          'targetUser',
        ]);
        assert.equal(first.openReportsOnTarget, 2);
        assert.deepEqual(first.group, {
          id: groupId,
          name: '운영 테스트',
          status: 'ACTIVE',
        });
        assert.deepEqual(first.reporter, {
          id: r1.id,
          displayName: 'co_reporter1',
          status: 'ACTIVE',
        });
        assert.deepEqual(first.targetUser, {
          id: uploader.id,
          displayName: 'co_uploader',
          status: 'ACTIVE',
        });
        assert.equal(first.resolution, null);
        const users = await get(
          '/v1/admin/reports?targetType=USER&limit=50'
        ).expect(200);
        assert.ok(
          users.body.items.every(
            (item: { targetType: string }) => item.targetType === 'USER'
          )
        );
        // Cursor pagination over the open queue keeps the order.
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Response = await get(
            `/v1/admin/reports?limit=3${cursor ? `&cursor=${cursor}` : ''}`
          ).expect(200);
          paged.push(...page.body.items.map((item: { id: string }) => item.id));
          cursor = page.body.nextCursor;
        } while (cursor);
        assert.deepEqual(paged.slice(0, ids.length), ids);
        assert.equal(
          (await get(`/v1/admin/reports?cursor=${randomUUID()}`).expect(400))
            .body.code,
          'ADMIN_REPORT_CURSOR_INVALID'
        );
        await get('/v1/admin/reports?status=CLOSED').expect(400);

        const photoDetail = await get(`/v1/admin/reports/${rPhoto1}`).expect(
          200
        );
        assert.equal(photoDetail.body.detail, '부적절한 사진');
        assert.deepEqual(Object.keys(photoDetail.body.target).sort(), [
          'albumId',
          'albumTitle',
          'photoId',
          'status',
          'uploadedAt',
        ]);
        assert.equal(photoDetail.body.target.albumTitle, albumTitle);
        assert.equal(photoDetail.body.target.status, 'READY');
        const commentDetail = await get(`/v1/admin/reports/${rComment}`).expect(
          200
        );
        assert.deepEqual(Object.keys(commentDetail.body.target).sort(), [
          'commentId',
          'createdAt',
          'deleted',
          'kind',
          'photoId',
        ]);
        assert.equal(commentDetail.body.detail, null);
        assert.doesNotMatch(
          JSON.stringify(commentDetail.body),
          /신고될 댓글 본문/
        );
        const userDetail = await get(`/v1/admin/reports/${rUser1}`).expect(200);
        assert.deepEqual(userDetail.body.target, {
          userId: target.id,
          membershipStatus: 'ACTIVE',
        });
        assert.equal((await audits('ADMIN_REPORT_VIEWED', rPhoto1)).length, 1);
        assert.equal(
          (await get(`/v1/admin/reports/${randomUUID()}`).expect(404)).body
            .code,
          'ADMIN_REPORT_NOT_FOUND'
        );

        // review → idempotent → dismiss → closed for every further change.
        const reviewed = await post(`/v1/admin/reports/${rDismiss}/review`)
          .send({})
          .expect(200);
        assert.equal(reviewed.body.status, 'REVIEWING');
        assert.equal((await audits('ADMIN_REPORT_VIEWED', rDismiss)).length, 0);
        // Already REVIEWING: no state change, but the response discloses the
        // report, so exactly one VIEWED row and no second REVIEWED row.
        await post(`/v1/admin/reports/${rDismiss}/review`).send({}).expect(200);
        assert.equal(
          (await audits('ADMIN_REPORT_REVIEWED', rDismiss)).length,
          1
        );
        assert.equal((await audits('ADMIN_REPORT_VIEWED', rDismiss)).length, 1);
        await post(`/v1/admin/reports/${rDismiss}/dismiss`)
          .send({})
          .expect(400);
        const dismissed = await post(`/v1/admin/reports/${rDismiss}/dismiss`)
          .send({ reason: '규정 위반 아님' })
          .expect(200);
        assert.equal(dismissed.body.status, 'DISMISSED');
        assert.equal(dismissed.body.resolution, 'NO_ACTION');
        assert.ok(dismissed.body.resolvedAt);
        for (const [path, body] of [
          ['review', {}],
          ['dismiss', { reason: '다시' }],
        ] as const) {
          const res = await post(`/v1/admin/reports/${rDismiss}/${path}`)
            .send(body)
            .expect(409);
          assert.equal(res.body.code, 'ADMIN_REPORT_ALREADY_CLOSED');
        }
        const dismissAudit = (
          await audits('ADMIN_REPORT_DISMISSED', rDismiss)
        )[0];
        assert.equal(dismissAudit.reason, '규정 위반 아님');
        // The reporter sees the status but never the operator's resolution.
        const mine = (
          await r3.agent.get('/v1/reports').expect(200)
        ).body.items.find((item: { id: string }) => item.id === rDismiss);
        assert.equal(mine.status, 'DISMISSED');
        assert.equal(mine.resolution, undefined);
      }
    );

    await t.test(
      'resolve: re-authentication, photo/comment deletion through the member paths and same-target auto-resolve',
      async () => {
        await staleReauth();
        const stale = await post(`/v1/admin/reports/${rPhoto1}/resolve`)
          .send({ action: 'DELETE_CONTENT', reason: '부적절' })
          .expect(403);
        assert.equal(stale.body.code, 'ADMIN_REAUTH_REQUIRED');
        assert.equal((await reportRow(rPhoto1)).status, 'RECEIVED');
        await reauthenticate();
        const notApplicable = await post(`/v1/admin/reports/${rUser1}/resolve`)
          .send({ action: 'DELETE_CONTENT', reason: '부적절' })
          .expect(400);
        assert.equal(notApplicable.body.code, 'ADMIN_ACTION_NOT_APPLICABLE');
        await post(`/v1/admin/reports/${rPhoto1}/resolve`)
          .send({ action: 'BAN', reason: '부적절' })
          .expect(400);

        const before = await usedBytes();
        assert.ok((await memberPhotoIds(r1.agent)).includes(pReported));
        const resolved = await post(`/v1/admin/reports/${rPhoto1}/resolve`)
          .send({ action: 'DELETE_CONTENT', reason: '부적절한 사진 삭제' })
          .expect(200);
        assert.equal(resolved.body.status, 'RESOLVED');
        assert.equal(resolved.body.resolution, 'CONTENT_DELETED');
        assert.equal(resolved.body.alsoResolved, 1);
        assert.equal(resolved.body.openReportsOnTarget, 0);
        assert.equal(resolved.body.target.status, 'DELETING');
        const sibling = await reportRow(rPhoto2);
        assert.equal(sibling.status, 'RESOLVED');
        assert.equal(sibling.resolution, 'CONTENT_DELETED');
        assert.ok(sibling.resolvedAt);
        // Same tombstone, quota release and durable cleanup job as member deletion.
        const deleted = (
          await query(
            'SELECT status::text AS status,"deletedAt" FROM woori.photos WHERE id=$1',
            [pReported]
          )
        )[0];
        assert.equal(deleted.status, 'DELETING');
        assert.ok(deleted.deletedAt);
        assert.equal(await usedBytes(), before - BigInt(PHOTO_BYTES));
        const job = (
          await query(
            'SELECT "objectKeys","completedAt" FROM woori.media_cleanup_jobs WHERE "photoId"=$1',
            [pReported]
          )
        )[0];
        const keys = photoKeys.get(pReported)!;
        assert.deepEqual(
          [...job.objectKeys].sort(),
          [keys.display, keys.original, keys.thumbnail].sort()
        );
        assert.equal(job.completedAt, null);
        assert.ok(!(await memberPhotoIds(r1.agent)).includes(pReported));
        await r1.agent
          .get(`${album}/photos/${pReported}/content?variant=display`)
          .expect(404);
        const again = await post(`/v1/admin/reports/${rPhoto2}/resolve`)
          .send({ action: 'DELETE_CONTENT', reason: '중복' })
          .expect(409);
        assert.equal(again.body.code, 'ADMIN_REPORT_ALREADY_CLOSED');
        const resolvedAudit = (
          await audits('ADMIN_REPORT_RESOLVED', rPhoto1)
        )[0];
        assert.equal(resolvedAudit.reason, '부적절한 사진 삭제');
        assert.deepEqual(resolvedAudit.metadata, {
          action: 'DELETE_CONTENT',
          alsoResolved: 1,
          effectApplied: true,
        });
        assert.deepEqual(
          (await audits('ADMIN_CONTENT_DELETED', pReported))[0].metadata,
          {
            reportId: rPhoto1,
            groupId,
          }
        );

        // Content already deleted by its uploader: idempotent, still resolved.
        await memberMutation(
          uploader.agent.delete(`${album}/photos/${pAlready}`)
        ).expect(204);
        const bytesAfterMemberDelete = await usedBytes();
        const idempotent = await post(`/v1/admin/reports/${rAlready}/resolve`)
          .send({ action: 'DELETE_CONTENT', reason: '이미 삭제됨' })
          .expect(200);
        assert.equal(idempotent.body.status, 'RESOLVED');
        assert.equal(idempotent.body.alsoResolved, 0);
        assert.equal(await usedBytes(), bytesAfterMemberDelete);
        assert.equal(
          (await audits('ADMIN_REPORT_RESOLVED', rAlready))[0].metadata
            .effectApplied,
          false
        );
        assert.equal(
          (await audits('ADMIN_CONTENT_DELETED', pAlready)).length,
          0
        );

        // Comment: soft delete like an owner deletion.
        const commentsBefore = (
          await r1.agent.get(`/v1/photos/${pTarget}/comments`).expect(200)
        ).body.comments.map((item: { id: string }) => item.id);
        assert.ok(commentsBefore.includes(cReported));
        const commentResolved = await post(
          `/v1/admin/reports/${rComment}/resolve`
        )
          .send({ action: 'DELETE_CONTENT', reason: '댓글 삭제' })
          .expect(200);
        assert.equal(commentResolved.body.target.deleted, true);
        const row = (
          await query(
            'SELECT "deletedAt",body FROM woori.comments WHERE id=$1',
            [cReported]
          )
        )[0];
        assert.ok(row.deletedAt);
        assert.equal(row.body, `신고될 댓글 본문 ${suffix}`);
        assert.ok(
          !(
            await r1.agent.get(`/v1/photos/${pTarget}/comments`).expect(200)
          ).body.comments.some((item: { id: string }) => item.id === cReported)
        );
      }
    );

    await t.test(
      'SUSPEND_USER revokes credentials atomically, refuses login and keeps shared content',
      async () => {
        const session = (
          await query('SELECT id FROM woori.sessions WHERE "tokenHash"=$1', [
            target.sessionHash,
          ])
        )[0].id;
        await owner.query(
          'INSERT INTO woori.push_installations(id,"userId",provider,"sessionId","endpointCiphertext","endpointHash") VALUES($1,$2,\'web\',$3,\'fixture\',$4)',
          [randomUUID(), target.id, session, randomBytes(32).toString('hex')]
        );
        await owner.query(
          'INSERT INTO woori.email_tokens(id,"userId","tokenHash",purpose,"expiresAt") VALUES($1,$2,$3,\'VERIFY_EMAIL\',now()+interval \'30 minutes\')',
          [randomUUID(), target.id, randomBytes(32).toString('hex')]
        );
        await target.agent.get('/v1/auth/me').expect(200);
        const suspended = await post(`/v1/admin/reports/${rUser1}/resolve`)
          .send({ action: 'SUSPEND_USER', reason: '반복 괴롭힘' })
          .expect(200);
        assert.equal(suspended.body.resolution, 'USER_SUSPENDED');
        assert.equal(suspended.body.alsoResolved, 1);
        assert.equal(suspended.body.targetUser.status, 'SUSPENDED');
        assert.equal((await reportRow(rUser2)).status, 'RESOLVED');
        const state = (
          await query(
            `SELECT u.status::text AS status,
              (SELECT count(*)::int FROM woori.sessions s WHERE s."userId"=u.id AND s."revokedAt" IS NULL) AS sessions,
              (SELECT count(*)::int FROM woori.push_installations p WHERE p."userId"=u.id AND (p."revokedAt" IS NULL OR p.enabled)) AS installations,
              (SELECT count(*)::int FROM woori.email_tokens e WHERE e."userId"=u.id AND e."consumedAt" IS NULL) AS tokens,
              (SELECT count(*)::int FROM woori.memberships m WHERE m."userId"=u.id AND m.status='ACTIVE') AS memberships
             FROM woori.users u WHERE u.id=$1`,
            [target.id]
          )
        )[0];
        assert.deepEqual(state, {
          status: 'SUSPENDED',
          sessions: 0,
          installations: 0,
          tokens: 0,
          memberships: 1,
        });
        await target.agent.get('/v1/auth/me').expect(401);
        const login = await memberMutation(api.post('/v1/auth/login'))
          .send({ username: target.username, password })
          .expect(403);
        assert.equal(login.body.code, 'ACCOUNT_SUSPENDED');
        assert.equal(login.headers['set-cookie'], undefined);
        // Shared content stays visible to the group.
        assert.ok((await memberPhotoIds(r1.agent)).includes(pTarget));
        assert.equal(
          (await audits('ADMIN_USER_SUSPENDED', target.id))[0].metadata
            .previousStatus,
          'ACTIVE'
        );
        // Already suspended: idempotent, still resolves the report.
        const again = await post(`/v1/admin/reports/${rTargetPhoto}/resolve`)
          .send({ action: 'SUSPEND_USER', reason: '이미 정지' })
          .expect(200);
        assert.equal(again.body.resolution, 'USER_SUSPENDED');
        assert.equal(
          (await audits('ADMIN_USER_SUSPENDED', target.id)).length,
          1
        );
        assert.ok((await memberPhotoIds(r1.agent)).includes(pTarget));

        // A withdrawn account cannot be suspended; the report stays open.
        const late = await signup('co_late');
        await app
          .get(InvitationsRepository)
          .join({ codeHash: hashInvitation(invitation.code) }, late.id);
        const rLate = await report(r2, {
          targetType: 'USER',
          targetId: late.id,
          groupId,
        });
        await app
          .get(AccountDeletionRepository)
          .delete(late.id, late.sessionHash, fixtureHash);
        const refused = await post(`/v1/admin/reports/${rLate}/resolve`)
          .send({ action: 'SUSPEND_USER', reason: '탈퇴 회원' })
          .expect(409);
        assert.equal(refused.body.code, 'ADMIN_USER_NOT_SUSPENDABLE');
        assert.equal((await reportRow(rLate)).status, 'RECEIVED');
        await post(`/v1/admin/reports/${rLate}/dismiss`)
          .send({ reason: '탈퇴함' })
          .expect(200);
      }
    );

    await t.test(
      'audited views: reason and re-auth required, display variant only, deleting photos until cleanup, rate limit',
      async () => {
        const view = (photoId: string, reason = '신고 확인을 위한 열람') =>
          post(`/v1/admin/photos/${photoId}/view`).send({ reason });
        await staleReauth();
        for (const op of [
          view(pTarget),
          post(`/v1/admin/comments/${cReported}/view`).send({
            reason: '신고 확인 열람',
          }),
        ])
          assert.equal(
            (await op.expect(403)).body.code,
            'ADMIN_REAUTH_REQUIRED'
          );
        await reauthenticate();
        await view(pTarget, '짧음').expect(400);
        await view(pTarget, '').expect(400);
        reads.length = 0;
        const shown = await view(pTarget).buffer(true).expect(200);
        assert.equal(shown.headers['content-type'], 'image/webp');
        assert.equal(shown.headers['cache-control'], 'private, no-store');
        assert.equal(shown.headers['content-disposition'], 'inline');
        const keys = photoKeys.get(pTarget)!;
        assert.deepEqual(reads, [keys.display]);
        assert.equal(
          Buffer.from(shown.body).toString(),
          `webp-bytes:${keys.display}`
        );
        const viewed = (await audits('ADMIN_PHOTO_VIEWED', pTarget)).at(-1);
        assert.equal(viewed.reason, '신고 확인을 위한 열람');
        assert.deepEqual(viewed.metadata, { photoId: pTarget, groupId });
        assert.equal(viewed.adminId, admin.id);
        // Deleted but not yet cleaned up: still viewable; after cleanup: 404.
        reads.length = 0;
        await view(pReported).expect(200);
        assert.deepEqual(reads, [photoKeys.get(pReported)!.display]);
        failReads = true;
        const gone = await view(pReported).expect(404);
        assert.equal(gone.body.code, 'ADMIN_PHOTO_NOT_FOUND');
        failReads = false;
        await owner.query(
          'UPDATE woori.media_cleanup_jobs SET "completedAt"=now() WHERE "photoId"=$1',
          [pReported]
        );
        await view(pReported).expect(404);
        for (const id of [pNoDisplay, randomUUID()])
          assert.equal(
            (await view(id).expect(404)).body.code,
            'ADMIN_PHOTO_NOT_FOUND'
          );
        // Original never served by any admin route.
        assert.ok(!reads.some((key) => key.includes('original')));

        const commentView = await post(`/v1/admin/comments/${cReported}/view`)
          .send({ reason: '신고 댓글 확인' })
          .expect(200);
        assert.deepEqual(Object.keys(commentView.body).sort(), [
          'author',
          'body',
          'createdAt',
          'deletedAt',
          'id',
          'kind',
          'photoId',
          'x',
          'y',
        ]);
        assert.equal(commentView.body.body, `신고될 댓글 본문 ${suffix}`);
        assert.ok(
          commentView.body.deletedAt,
          'soft-deleted comment remains viewable'
        );
        assert.deepEqual(commentView.body.author, {
          id: commenter.id,
          displayName: 'co_commenter',
        });
        const commentAudit = (
          await audits('ADMIN_COMMENT_VIEWED', cReported)
        )[0];
        assert.equal(commentAudit.reason, '신고 댓글 확인');
        assert.deepEqual(commentAudit.metadata, {
          commentId: cReported,
          photoId: pTarget,
          groupId,
        });
        assert.equal(
          (
            await post(`/v1/admin/comments/${randomUUID()}/view`)
              .send({ reason: '없는 댓글' })
              .expect(404)
          ).body.code,
          'ADMIN_COMMENT_NOT_FOUND'
        );
        // Per-admin view budget (120 per hour) bounds bulk scraping.
        const bucket = rateLimitKey(
          'auth',
          `admin-view:${admin.id}`,
          new Date(),
          60 * MINUTE
        );
        await owner.query(
          'INSERT INTO woori.rate_limit_buckets (id,"windowStart",attempts) VALUES ($1,$2,120) ON CONFLICT(id) DO UPDATE SET attempts=120',
          [bucket.id, bucket.windowStart]
        );
        assert.equal(
          (await view(pTarget).expect(429)).body.code,
          'TOO_MANY_REQUESTS'
        );
        await post(`/v1/admin/comments/${cReported}/view`)
          .send({ reason: '한도 초과 확인' })
          .expect(429);

        // Audit rows: listed metadata keys only, no secrets or member text.
        const rows = await query('SELECT * FROM woori.admin_audit_logs');
        const allowed = new Set<string>(ADMIN_AUDIT_METADATA_KEYS);
        for (const row of rows)
          for (const key of Object.keys(row.metadata))
            assert.ok(allowed.has(key), key);
        const dump = JSON.stringify(rows.map((row) => row.metadata));
        for (const secretValue of [
          password,
          token,
          `신고될 댓글 본문`,
          '부적절한 사진',
          '문의 본문입니다',
          '@',
        ])
          assert.ok(!dump.includes(secretValue), secretValue);
      }
    );
  } finally {
    // The media cleanup worker suite (auth-groups) runs later in this same
    // disposable database and asserts on every cleanup job, so the jobs created
    // by this suite's fixture deletions are removed here (after their contents
    // were asserted above).
    if (albumIdForCleanup)
      await owner
        .query(
          'DELETE FROM woori.media_cleanup_jobs j USING woori.photos p WHERE p.id=j."photoId" AND p."albumId"=$1',
          [albumIdForCleanup]
        )
        .catch(() => undefined);
    await app.close();
    await owner.end();
  }
});
