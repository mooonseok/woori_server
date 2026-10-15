import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { AccountDeletionRepository } from '../src/domain/auth/account-deletion.repository';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { ServiceSupportRepository } from '../src/domain/service-support/service-support.repository';
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
const noticeKeys = ['id', 'publishedAt', 'title', 'updatedAt'];
const inquiryKeys = [
  'answer',
  'answeredAt',
  'body',
  'category',
  'createdAt',
  'id',
  'status',
  'title',
];
const inquirySummaryKeys = [
  'answeredAt',
  'category',
  'createdAt',
  'id',
  'status',
  'title',
];
test('isolated PostgreSQL: read-only notices and own member inquiries', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const password = 'support-integration-password-2026';
  const suffix = randomBytes(4).toString('hex');
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const fixtureHash = await hashPassword(password);
    // Fixture accounts use the repository so this suite does not consume the
    // shared IP signup quota of unrelated integration suites.
    const signup = async (label: string, verified: boolean) => {
      const agent = request.agent(app.getHttpServer());
      const token = createToken();
      const user = await app.get(AuthRepository).createUser(
        {
          username: `${label}_${suffix}`,
          email: `${label}_${suffix}@example.test`,
          displayName: label,
          passwordHash: fixtureHash,
          verifiedAt: verified ? new Date() : null,
        },
        hashToken(token)
      );
      agent.set('Cookie', `woori_session=${token}`);
      return { agent, id: user.id, sessionHash: hashToken(token) };
    };
    // Email verification is not required to read notices or ask for help.
    const writer = await signup('s_writer', false),
      peer = await signup('s_peer', true),
      leaver = await signup('s_leaver', true);
    const count = async (userId: string) =>
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM woori.inquiries WHERE "userId"=$1',
          [userId]
        )
      ).rows[0].n as number;

    // Notices are inserted with the owner connection: the runtime role cannot
    // write them and no member API authors notices. Microsecond timestamps
    // exercise keyset comparison against stored precision.
    const minutesAgo = (minutes: number, micros = '000') =>
      new Date(Date.now() - minutes * 60_000)
        .toISOString()
        .replace('Z', `${micros}Z`);
    const notice = async (
      label: string,
      status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
      publishedAt: string | null,
      id = randomUUID()
    ) => {
      await admin.query(
        'INSERT INTO woori.notices(id,title,body,status,"publishedAt","updatedAt") VALUES($1,$2,$3,$4,$5,now())',
        [
          id,
          `${label} ${suffix}`,
          `${label} 본문\n둘째 줄`,
          status,
          publishedAt,
        ]
      );
      return id;
    };
    const tie = minutesAgo(40, '250');
    const [tieLow, tieHigh] = [randomUUID(), randomUUID()].sort();
    const oldest = await notice(
      '가장 오래된 공지',
      'PUBLISHED',
      minutesAgo(50)
    );
    await notice('같은 시각 공지 A', 'PUBLISHED', tie, tieLow);
    await notice('같은 시각 공지 B', 'PUBLISHED', tie, tieHigh);
    // Same millisecond, different microseconds: a JS Date cursor would skip one.
    const sameMillisecond = minutesAgo(30);
    const precise = await notice(
      '정밀 공지',
      'PUBLISHED',
      sameMillisecond.replace('000Z', '999Z')
    );
    const sibling = await notice(
      '정밀 공지 이웃',
      'PUBLISHED',
      sameMillisecond.replace('000Z', '500Z')
    );
    const newest = await notice('최신 공지', 'PUBLISHED', minutesAgo(1));
    const visibleOrder: string[] = [
      newest,
      precise,
      sibling,
      tieHigh,
      tieLow,
      oldest,
    ];
    const hidden = {
      draft: await notice('초안', 'DRAFT', minutesAgo(20)),
      undated: await notice('날짜 없는 초안', 'DRAFT', null),
      archived: await notice('보관', 'ARCHIVED', minutesAgo(10)),
      future: await notice(
        '예약',
        'PUBLISHED',
        new Date(Date.now() + 86_400_000).toISOString()
      ),
    };
    const hiddenIds = Object.values(hidden);

    await t.test(
      'migration enables RLS and the runtime role changes only admin-managed notice and inquiry columns',
      async () => {
        const rls = await admin.query(
          "SELECT c.relname, c.relrowsecurity, EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='woori' AND p.tablename=c.relname AND p.policyname='server_api_access') AS policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='woori' AND c.relname IN ('notices','inquiries') ORDER BY c.relname"
        );
        assert.deepEqual(rls.rows, [
          { relname: 'inquiries', relrowsecurity: true, policy: true },
          { relname: 'notices', relrowsecurity: true, policy: true },
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
          // W06 admin API: notice authoring (INSERT + column UPDATE, never
          // DELETE) and inquiry answers/status (column UPDATE only). Members still
          // have no authoring route (asserted over HTTP below).
          assert.deepEqual(await privileges('notices'), {
            read: true,
            insert: true,
            update: false,
            delete: false,
            truncate: false,
          });
          assert.deepEqual(await privileges('inquiries'), {
            read: true,
            insert: true,
            update: false,
            delete: true,
            truncate: false,
          });
          const updatable = async (table: string) =>
            (
              await runtime.query(
                "SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user, $1, a.attname, 'UPDATE') ORDER BY a.attname",
                [`woori.${table}`]
              )
            ).rows.map((row: { name: string }) => row.name);
          assert.deepEqual(await updatable('notices'), [
            'body',
            'publishedAt',
            'status',
            'title',
            'updatedAt',
          ]);
          assert.deepEqual(await updatable('inquiries'), [
            'answer',
            'answeredAt',
            'status',
            'updatedAt',
          ]);
          for (const statement of [
            'DELETE FROM woori.notices',
            `UPDATE woori.notices SET id='${randomUUID()}'`,
            'UPDATE woori.notices SET "createdAt"=now()',
            `UPDATE woori.inquiries SET "userId"='${randomUUID()}'`,
            "UPDATE woori.inquiries SET body='changed', title='changed'",
            "UPDATE woori.inquiries SET category='OTHER'",
            'TRUNCATE woori.notices',
          ])
            await assert.rejects(
              runtime.query(statement),
              (error: { code?: string }) => error.code === '42501',
              statement
            );
        } finally {
          await runtime.end();
        }
      }
    );

    await t.test(
      'every route requires a member session and mutations require Origin and X-Woori-Request',
      async () => {
        const id = randomUUID();
        for (const path of [
          '/v1/notices',
          `/v1/notices/${id}`,
          '/v1/inquiries',
          `/v1/inquiries/${id}`,
        ]) {
          const result = await api.get(path).expect(401);
          assert.equal(result.body.code, 'AUTHENTICATION_REQUIRED');
          assert.equal(result.headers['cache-control'], 'no-store');
        }
        const anonymous = await mutate(api.post('/v1/inquiries'))
          .send({ category: 'BUG', title: '제목', body: '본문' })
          .expect(401);
        assert.equal(anonymous.body.code, 'AUTHENTICATION_REQUIRED');
        const csrf = await writer.agent
          .post('/v1/inquiries')
          .send({ category: 'BUG', title: '제목', body: '본문' })
          .expect(403);
        assert.equal(csrf.body.code, 'REQUEST_ORIGIN_REJECTED');
        await writer.agent
          .post('/v1/inquiries')
          .set('Origin', process.env.WEB_ORIGIN!)
          .send({ category: 'BUG', title: '제목', body: '본문' })
          .expect(403);
        await writer.agent
          .post('/v1/inquiries')
          .set('Origin', 'https://evil.example')
          .set('X-Woori-Request', '1')
          .send({ category: 'BUG', title: '제목', body: '본문' })
          .expect(403);
        assert.equal(await count(writer.id), 0);
      }
    );

    await t.test(
      'notices list only published, already published items in publishedAt/id order',
      async () => {
        const first = await writer.agent.get('/v1/notices').expect(200);
        assert.equal(first.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(first.body).sort(), [
          'items',
          'nextCursor',
        ]);
        assert.equal(first.body.nextCursor, null);
        const ids = first.body.items.map((item: { id: string }) => item.id);
        assert.deepEqual(
          ids.filter((id: string) => visibleOrder.includes(id)),
          visibleOrder
        );
        for (const id of hiddenIds) assert.ok(!ids.includes(id), id);
        for (const item of first.body.items)
          assert.deepEqual(Object.keys(item).sort(), noticeKeys);
        const latest = first.body.items.find(
          (item: { id: string }) => item.id === newest
        );
        assert.equal(latest.title, `최신 공지 ${suffix}`);
        assert.ok(!Number.isNaN(Date.parse(latest.publishedAt)));
        assert.ok(!Number.isNaN(Date.parse(latest.updatedAt)));
        // Every item is visible now, so the timestamps never go backwards.
        const times = first.body.items.map((item: { publishedAt: string }) =>
          Date.parse(item.publishedAt)
        );
        assert.deepEqual(
          times,
          [...times].sort((a, b) => b - a)
        );
      }
    );

    await t.test(
      'notice cursor pagination walks every page once and rejects stale cursors',
      async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const query: Record<string, string | number> = { limit: 2 };
          if (cursor) query.cursor = cursor;
          const page = await peer.agent
            .get('/v1/notices')
            .query(query)
            .expect(200);
          assert.ok(page.body.items.length <= 2);
          if (page.body.nextCursor) {
            assert.equal(page.body.items.length, 2);
            assert.equal(page.body.nextCursor, page.body.items.at(-1).id);
          }
          seen.push(...page.body.items.map((item: { id: string }) => item.id));
          cursor = page.body.nextCursor;
          pages++;
        } while (cursor && pages < 20);
        assert.equal(cursor, null);
        assert.equal(new Set(seen).size, seen.length);
        assert.deepEqual(
          seen.filter((id) => visibleOrder.includes(id)),
          visibleOrder
        );
        // The cursor compares stored microseconds, so the same-millisecond
        // neighbour and both equal-time notices follow in order.
        const afterPrecise = await peer.agent
          .get('/v1/notices')
          .query({ limit: 3, cursor: precise })
          .expect(200);
        assert.deepEqual(
          afterPrecise.body.items.map((item: { id: string }) => item.id),
          [sibling, tieHigh, tieLow]
        );
        for (const cursorId of [...hiddenIds, randomUUID()]) {
          const stale = await peer.agent
            .get('/v1/notices')
            .query({ cursor: cursorId })
            .expect(404);
          assert.equal(stale.body.code, 'NOTICE_NOT_FOUND');
        }
        for (const query of [
          { limit: 0 },
          { limit: 51 },
          { limit: 'abc' },
          { limit: 1.5 },
          { cursor: 'not-a-uuid' },
          { status: 'DRAFT' },
        ])
          await peer.agent.get('/v1/notices').query(query).expect(400);
        await peer.agent.get('/v1/notices').query({ limit: 50 }).expect(200);
        await peer.agent.get('/v1/notices').query({ limit: 1 }).expect(200);
      }
    );

    await t.test('notice detail returns visible notices only', async () => {
      const detail = await writer.agent
        .get(`/v1/notices/${precise}`)
        .expect(200);
      assert.equal(detail.headers['cache-control'], 'no-store');
      assert.deepEqual(
        Object.keys(detail.body).sort(),
        ['body', ...noticeKeys].sort()
      );
      assert.equal(detail.body.id, precise);
      assert.equal(detail.body.body, '정밀 공지 본문\n둘째 줄');
      for (const id of [...hiddenIds, randomUUID()]) {
        const missing = await writer.agent.get(`/v1/notices/${id}`).expect(404);
        assert.equal(missing.body.code, 'NOTICE_NOT_FOUND');
      }
      await writer.agent.get('/v1/notices/not-a-uuid').expect(400);
      // A notice becomes visible exactly when its publication time passes.
      await admin.query(
        'UPDATE woori.notices SET "publishedAt"=now() - interval \'1 second\' WHERE id=$1',
        [hidden.future]
      );
      await writer.agent.get(`/v1/notices/${hidden.future}`).expect(200);
      await admin.query(
        'UPDATE woori.notices SET "publishedAt"=now() + interval \'1 day\' WHERE id=$1',
        [hidden.future]
      );
      await writer.agent.get(`/v1/notices/${hidden.future}`).expect(404);
    });

    await t.test(
      'no member route authors notices or answers inquiries; admin stays closed to member sessions',
      async () => {
        const id = randomUUID();
        const before = (
          await admin.query('SELECT count(*)::int AS n FROM woori.notices')
        ).rows[0].n;
        await mutate(writer.agent.post('/v1/notices'))
          .send({ title: '회원 공지', body: '본문' })
          .expect(404);
        await mutate(writer.agent.patch(`/v1/notices/${precise}`))
          .send({ title: '변경' })
          .expect(404);
        await mutate(writer.agent.put(`/v1/notices/${precise}`))
          .send({ title: '변경' })
          .expect(404);
        await mutate(writer.agent.delete(`/v1/notices/${precise}`)).expect(404);
        await mutate(writer.agent.patch(`/v1/inquiries/${id}`))
          .send({ status: 'CLOSED' })
          .expect(404);
        await mutate(writer.agent.delete(`/v1/inquiries/${id}`)).expect(404);
        await mutate(writer.agent.post(`/v1/inquiries/${id}/answer`))
          .send({ answer: '자체 답변' })
          .expect(404);
        for (const path of [
          '/v1/admin/notices',
          '/v1/admin/inquiries',
          `/v1/admin/inquiries/${id}`,
        ]) {
          // Member sessions are not admin sessions: 401 in the admin realm.
          const result = await writer.agent.get(path).expect(401);
          assert.equal(result.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        }
        for (const op of [
          writer.agent.post('/v1/admin/notices'),
          writer.agent.patch(`/v1/admin/inquiries/${id}`),
        ]) {
          const result = await mutate(op)
            .send({ title: '관리자 흉내', answer: '답변' })
            .expect(401);
          assert.equal(result.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        }
        assert.equal(
          (await admin.query('SELECT count(*)::int AS n FROM woori.notices'))
            .rows[0].n,
          before
        );
      }
    );

    const created: string[] = [];
    await t.test(
      'inquiry creation trims text and returns the received inquiry',
      async () => {
        const result = await mutate(writer.agent.post('/v1/inquiries'))
          .send({
            category: 'PHOTO',
            title: '  사진이 보이지 않아요 　',
            body: '\n  업로드 후 썸네일이 비어 있어요.\r\n\t재현: 앨범 열기  \n ',
          })
          .expect(201);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(result.body).sort(), inquiryKeys);
        assert.equal(result.body.category, 'PHOTO');
        assert.equal(result.body.title, '사진이 보이지 않아요');
        assert.equal(
          result.body.body,
          '업로드 후 썸네일이 비어 있어요.\r\n\t재현: 앨범 열기'
        );
        assert.equal(result.body.status, 'RECEIVED');
        assert.equal(result.body.answer, null);
        assert.equal(result.body.answeredAt, null);
        assert.ok(!Number.isNaN(Date.parse(result.body.createdAt)));
        const stored = (
          await admin.query(
            'SELECT "userId",title,body,status FROM woori.inquiries WHERE id=$1',
            [result.body.id]
          )
        ).rows[0];
        assert.deepEqual(stored, {
          userId: writer.id,
          title: '사진이 보이지 않아요',
          body: '업로드 후 썸네일이 비어 있어요.\r\n\t재현: 앨범 열기',
          status: 'RECEIVED',
        });
        created.push(result.body.id);
        const maximum = await mutate(writer.agent.post('/v1/inquiries'))
          .send({
            category: 'OTHER',
            title: '가'.repeat(100),
            body: '❤️'.repeat(1000),
          })
          .expect(201);
        assert.equal(maximum.body.body, '❤️'.repeat(1000));
        created.push(maximum.body.id);
      }
    );

    await t.test(
      'invalid inquiries are rejected with 400 and do not consume the quota',
      async () => {
        const valid = { category: 'BUG', title: '제목', body: '본문' };
        for (const bad of [
          { title: '' },
          { title: '   \t ' },
          { title: 'a'.repeat(101) },
          { title: '첫 줄\n둘째 줄' },
          { title: '널\u0000' },
          { body: '' },
          { body: ' \n\r\n ' },
          { body: 'b'.repeat(2001) },
          { body: '❤️'.repeat(1001) },
          { body: '널\u0000문자' },
          { body: '벨\u0007' },
          { body: '이스케이프\u001b[2J' },
          { category: 'SPAM' },
          { category: 'bug' },
          { category: null },
          { title: 42 },
          { status: 'ANSWERED' },
          { userId: peer.id },
          { answer: '자체 답변' },
        ])
          await mutate(writer.agent.post('/v1/inquiries'))
            .send({ ...valid, ...bad })
            .expect(400);
        await mutate(writer.agent.post('/v1/inquiries'))
          .send({ title: '분류 없음', body: '본문' })
          .expect(400);
        assert.equal(await count(writer.id), 2);
      }
    );

    await t.test(
      'a sixth inquiry within 24 hours is rate limited per user only',
      async () => {
        for (const category of ['ACCOUNT', 'GROUP', 'NOTIFICATION']) {
          const result = await mutate(writer.agent.post('/v1/inquiries'))
            .send({
              category,
              title: `${category} 문의`,
              body: '도움이 필요해요',
            })
            .expect(201);
          created.push(result.body.id);
        }
        const limited = await mutate(writer.agent.post('/v1/inquiries'))
          .send({ category: 'BUG', title: '여섯 번째', body: '본문' })
          .expect(429);
        assert.equal(limited.body.code, 'TOO_MANY_REQUESTS');
        assert.equal(limited.headers['cache-control'], 'no-store');
        assert.equal(await count(writer.id), 5);
        // The window is an exact rolling 24 hours over stored inquiries: once
        // one inquiry is older than 24 hours, exactly one more is accepted.
        await admin.query(
          'UPDATE woori.inquiries SET "createdAt"=now()-interval \'24 hours 1 minute\' WHERE id=$1',
          [created[1]]
        );
        const reopened = await mutate(writer.agent.post('/v1/inquiries'))
          .send({ category: 'BUG', title: '창 밖으로 밀린 뒤', body: '본문' })
          .expect(201);
        created.push(reopened.body.id);
        await mutate(writer.agent.post('/v1/inquiries'))
          .send({ category: 'BUG', title: '다시 한도', body: '본문' })
          .expect(429);
        assert.equal(await count(writer.id), 6);
        const other = await mutate(peer.agent.post('/v1/inquiries'))
          .send({ category: 'OTHER', title: '다른 회원 문의', body: '본문' })
          .expect(201);
        assert.equal(other.body.status, 'RECEIVED');
      }
    );

    await t.test(
      'inquiry list and detail expose only the current member’s inquiries',
      async () => {
        const all = await writer.agent.get('/v1/inquiries').expect(200);
        assert.equal(all.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(all.body).sort(), ['items', 'nextCursor']);
        assert.equal(all.body.nextCursor, null);
        const expected = (
          await admin.query(
            'SELECT id FROM woori.inquiries WHERE "userId"=$1 ORDER BY "createdAt" DESC, id DESC',
            [writer.id]
          )
        ).rows.map((row: { id: string }) => row.id);
        assert.equal(expected.length, 6);
        assert.deepEqual(
          all.body.items.map((item: { id: string }) => item.id),
          expected
        );
        assert.deepEqual([...expected].sort(), [...created].sort());
        for (const item of all.body.items)
          assert.deepEqual(Object.keys(item).sort(), inquirySummaryKeys);
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const query: Record<string, string | number> = { limit: 2 };
          if (cursor) query.cursor = cursor;
          const page = await writer.agent
            .get('/v1/inquiries')
            .query(query)
            .expect(200);
          seen.push(...page.body.items.map((item: { id: string }) => item.id));
          cursor = page.body.nextCursor;
        } while (cursor && seen.length < 20);
        assert.deepEqual(seen, expected);
        const peerList = await peer.agent.get('/v1/inquiries').expect(200);
        assert.equal(peerList.body.items.length, 1);
        const peerInquiry = peerList.body.items[0].id as string;
        assert.ok(!expected.includes(peerInquiry));
        for (const id of [peerInquiry, randomUUID()]) {
          const missing = await writer.agent
            .get(`/v1/inquiries/${id}`)
            .expect(404);
          assert.equal(missing.body.code, 'INQUIRY_NOT_FOUND');
          const stale = await writer.agent
            .get('/v1/inquiries')
            .query({ cursor: id })
            .expect(404);
          assert.equal(stale.body.code, 'INQUIRY_NOT_FOUND');
        }
        for (const query of [
          { limit: 0 },
          { limit: 51 },
          { cursor: 'nope' },
          { userId: peer.id },
        ])
          await writer.agent.get('/v1/inquiries').query(query).expect(400);
        await writer.agent.get('/v1/inquiries/not-a-uuid').expect(400);
        const own = await writer.agent
          .get(`/v1/inquiries/${created[0]}`)
          .expect(200);
        assert.deepEqual(Object.keys(own.body).sort(), inquiryKeys);
        assert.equal(own.body.title, '사진이 보이지 않아요');
        // An answer written later by the admin feature is shown read-only.
        await admin.query(
          'UPDATE woori.inquiries SET status=\'ANSWERED\', answer=$2, "answeredAt"=now(), "updatedAt"=now() WHERE id=$1',
          [created[0], '썸네일 재처리를 완료했어요.']
        );
        const answered = await writer.agent
          .get(`/v1/inquiries/${created[0]}`)
          .expect(200);
        assert.equal(answered.body.status, 'ANSWERED');
        assert.equal(answered.body.answer, '썸네일 재처리를 완료했어요.');
        assert.ok(!Number.isNaN(Date.parse(answered.body.answeredAt)));
        const summary = (
          await writer.agent.get('/v1/inquiries').expect(200)
        ).body.items.find((item: { id: string }) => item.id === created[0]);
        assert.equal(summary.status, 'ANSWERED');
        assert.equal(summary.answeredAt, answered.body.answeredAt);
      }
    );

    await t.test(
      'account deletion erases the deleter’s inquiries and keeps other members’ inquiries',
      async () => {
        for (const title of ['탈퇴 전 문의 1', '탈퇴 전 문의 2'])
          await mutate(leaver.agent.post('/v1/inquiries'))
            .send({ category: 'ACCOUNT', title, body: '탈퇴 예정' })
            .expect(201);
        assert.equal(await count(leaver.id), 2);
        const writerBefore = await count(writer.id),
          peerBefore = await count(peer.id);
        await mutate(leaver.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        assert.equal(await count(leaver.id), 0);
        assert.equal(await count(writer.id), writerBefore);
        assert.equal(await count(peer.id), peerBefore);
        await leaver.agent.get('/v1/inquiries').expect(401);
        await mutate(leaver.agent.post('/v1/inquiries'))
          .send({ category: 'ACCOUNT', title: '탈퇴 후', body: '본문' })
          .expect(401);
        assert.equal(await count(leaver.id), 0);
      }
    );

    await t.test(
      'concurrent submissions cannot exceed the per-user quota',
      async () => {
        const burst = await signup('s_burst', true);
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            mutate(burst.agent.post('/v1/inquiries')).send({
              category: 'OTHER',
              title: `동시 문의 ${index}`,
              body: '본문',
            })
          )
        );
        const statuses = results.map((result) => result.status).sort();
        assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429, 429]);
        assert.equal(await count(burst.id), 5);
      }
    );

    await t.test(
      'a submission racing account deletion leaves no inquiry for the deleted account',
      async () => {
        for (let round = 0; round < 3; round++) {
          const racer = await signup(`s_race${round}`, true);
          const results = await Promise.allSettled([
            app
              .get(AccountDeletionRepository)
              .delete(racer.id, racer.sessionHash, fixtureHash),
            app.get(ServiceSupportRepository).createInquiry(racer.id, {
              category: 'ACCOUNT',
              title: '탈퇴 경합',
              body: '본문',
            }),
          ]);
          assert.equal(results[0].status, 'fulfilled');
          if (results[1].status === 'rejected')
            assert.equal(results[1].reason?.getStatus?.(), 401);
          assert.equal(
            (
              await admin.query('SELECT status FROM woori.users WHERE id=$1', [
                racer.id,
              ])
            ).rows[0].status,
            'DELETED'
          );
          assert.equal(await count(racer.id), 0);
        }
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
