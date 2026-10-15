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
import { ReportsRepository } from '../src/domain/reports/reports.repository';
import { hashToken, createToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';

function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  return url.toString();
}
const resultKeys = [
  'createdAt',
  'duplicate',
  'id',
  'reason',
  'resolvedAt',
  'status',
  'targetType',
];
const itemKeys = resultKeys.filter((key) => key !== 'duplicate');
type Agent = ReturnType<typeof request.agent>;
test('isolated PostgreSQL: operator-only content and member reports', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
  });
  const app = await createApp();
  const password = 'reports-integration-password-2026';
  const suffix = randomBytes(4).toString('hex');
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const fixtureHash = await hashPassword(password);
    // Fixture accounts and memberships use repositories so this suite does not
    // consume the shared IP signup/join quotas of unrelated suites.
    const signup = async (label: string) => {
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
      return { agent, id: user.id, sessionHash: hashToken(token) };
    };
    const owner = await signup('r_owner'),
      reporter = await signup('r_reporter'),
      target = await signup('r_target'),
      leaver = await signup('r_leaver'),
      removed = await signup('r_removed'),
      outsider = await signup('r_outsider'),
      heavy = await signup('r_heavy'),
      withdrawer = await signup('r_withdraw'),
      departing = await signup('r_departing');
    const groupId = (
      await mutate(owner.agent.post('/v1/groups'))
        .send({ name: '신고 테스트' })
        .expect(201)
    ).body.group.id as string;
    const invitation = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/invitations`))
        .send({ maxUses: 50 })
        .expect(201)
    ).body;
    for (const member of [
      reporter,
      target,
      leaver,
      removed,
      heavy,
      withdrawer,
      departing,
    ])
      await app
        .get(InvitationsRepository)
        .join({ codeHash: hashInvitation(invitation.code) }, member.id);
    await mutate(leaver.agent.post(`/v1/groups/${groupId}/leave`)).expect(204);
    await mutate(
      owner.agent.delete(`/v1/groups/${groupId}/members/${removed.id}`)
    ).expect(204);
    const albumId = (
      await mutate(owner.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '신고 앨범' })
        .expect(201)
    ).body.album.id as string;
    const photo = async (uploaderId: string, status = 'READY') => {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height,"deletedAt") VALUES($1,$2,$3,$4,$5,1,1,1,$6)',
        [
          id,
          groupId,
          albumId,
          uploaderId,
          status,
          status === 'DELETED' ? new Date() : null,
        ]
      );
      return id;
    };
    const comment = async (
      author: { agent: Agent },
      photoId: string,
      body: string
    ) =>
      (
        await mutate(author.agent.post(`/v1/photos/${photoId}/comments`))
          .send({ body, kind: 'GENERAL' })
          .expect(201)
      ).body.comment.id as string;
    const targetPhoto = await photo(target.id),
      reporterPhoto = await photo(reporter.id),
      deletedPhoto = await photo(target.id, 'DELETED'),
      departingPhoto = await photo(departing.id),
      departingLater = await photo(departing.id),
      racePhoto = await photo(target.id);
    const targetComment = await comment(target, targetPhoto, '대상 댓글'),
      reporterComment = await comment(reporter, targetPhoto, '내 댓글'),
      deletedComment = await comment(target, targetPhoto, '삭제될 댓글');
    await admin.query(
      'UPDATE woori.comments SET "deletedAt"=now() WHERE id=$1',
      [deletedComment]
    );
    const file = (agent: Agent, body: Record<string, unknown>): Test =>
      mutate(agent.post('/v1/reports')).send(body);
    const stored = async (reporterId: string, targetId: string) =>
      (
        await admin.query(
          'SELECT * FROM woori.content_reports WHERE "reporterId"=$1 AND "targetId"=$2',
          [reporterId, targetId]
        )
      ).rows;
    const missing = async (agent: Agent, body: Record<string, unknown>) => {
      const result = await file(agent, body).expect(404);
      assert.equal(result.body.code, 'REPORT_TARGET_NOT_FOUND');
    };

    await t.test(
      'migration enables RLS and the runtime role can file and anonymize but never delete reports',
      async () => {
        const rls = await admin.query(
          "SELECT c.relrowsecurity, EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='woori' AND p.tablename='content_reports' AND p.policyname='server_api_access') AS policy FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='woori' AND c.relname='content_reports'"
        );
        assert.deepEqual(rls.rows, [{ relrowsecurity: true, policy: true }]);
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = (
            await runtime.query(
              "SELECT has_table_privilege(current_user, 'woori.content_reports', 'SELECT') AS read, has_table_privilege(current_user, 'woori.content_reports', 'INSERT') AS insert, has_table_privilege(current_user, 'woori.content_reports', 'UPDATE') AS update, has_table_privilege(current_user, 'woori.content_reports', 'DELETE') AS delete, has_table_privilege(current_user, 'woori.content_reports', 'TRUNCATE') AS truncate"
            )
          ).rows[0];
          // UPDATE is column-scoped: only the withdrawal erasure of detail.
          assert.deepEqual(privileges, {
            read: true,
            insert: true,
            update: false,
            delete: false,
            truncate: false,
          });
          const columns = (
            await runtime.query(
              "SELECT has_column_privilege(current_user, 'woori.content_reports', 'detail', 'UPDATE') AS detail, has_column_privilege(current_user, 'woori.content_reports', 'updatedAt', 'UPDATE') AS \"updatedAt\", has_column_privilege(current_user, 'woori.content_reports', 'status', 'UPDATE') AS status, has_column_privilege(current_user, 'woori.content_reports', 'resolvedAt', 'UPDATE') AS \"resolvedAt\", has_column_privilege(current_user, 'woori.content_reports', 'reason', 'UPDATE') AS reason"
            )
          ).rows[0];
          assert.deepEqual(columns, {
            detail: true,
            updatedAt: true,
            status: false,
            resolvedAt: false,
            reason: false,
          });
          for (const statement of [
            'DELETE FROM woori.content_reports',
            "UPDATE woori.content_reports SET status='RESOLVED'",
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
      'reports require a member session and Origin/X-Woori-Request',
      async () => {
        const body = {
          targetType: 'PHOTO',
          targetId: targetPhoto,
          reason: 'SPAM',
        };
        for (const result of [
          await api.get('/v1/reports').expect(401),
          await mutate(api.post('/v1/reports')).send(body).expect(401),
        ])
          assert.equal(result.body.code, 'AUTHENTICATION_REQUIRED');
        const csrf = await reporter.agent
          .post('/v1/reports')
          .send(body)
          .expect(403);
        assert.equal(csrf.body.code, 'REQUEST_ORIGIN_REJECTED');
        await reporter.agent
          .post('/v1/reports')
          .set('Origin', 'https://evil.example')
          .set('X-Woori-Request', '1')
          .send(body)
          .expect(403);
        assert.equal((await stored(reporter.id, targetPhoto)).length, 0);
      }
    );

    await t.test(
      'photo, comment and member reports are stored without notifying anyone or hiding content',
      async () => {
        const counts = async () =>
          (
            await admin.query(
              'SELECT (SELECT count(*)::int FROM woori.notifications) AS notifications, (SELECT count(*)::int FROM woori.outbox_events) AS outbox'
            )
          ).rows[0];
        const before = await counts();
        const photoReport = await file(reporter.agent, {
          targetType: 'PHOTO',
          targetId: targetPhoto,
          reason: 'INAPPROPRIATE',
          detail: '  부적절한 사진이에요.\n확인 부탁드려요. \t',
        }).expect(201);
        assert.equal(photoReport.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(photoReport.body).sort(), resultKeys);
        assert.equal(photoReport.body.targetType, 'PHOTO');
        assert.equal(photoReport.body.reason, 'INAPPROPRIATE');
        assert.equal(photoReport.body.status, 'RECEIVED');
        assert.equal(photoReport.body.resolvedAt, null);
        assert.equal(photoReport.body.duplicate, false);
        const [row] = await stored(reporter.id, targetPhoto);
        assert.equal(row.groupId, groupId);
        assert.equal(row.targetUserId, target.id);
        assert.equal(row.detail, '부적절한 사진이에요.\n확인 부탁드려요.');
        const commentReport = await file(reporter.agent, {
          targetType: 'COMMENT',
          targetId: targetComment,
          groupId,
          reason: 'HARASSMENT',
          detail: '   ',
        }).expect(201);
        assert.equal(commentReport.body.targetType, 'COMMENT');
        const [commentRow] = await stored(reporter.id, targetComment);
        assert.equal(commentRow.targetUserId, target.id);
        assert.equal(commentRow.groupId, groupId);
        assert.equal(commentRow.detail, null);
        const memberReport = await file(reporter.agent, {
          targetType: 'USER',
          targetId: target.id,
          groupId,
          reason: 'PRIVACY',
        }).expect(201);
        assert.equal(memberReport.body.targetType, 'USER');
        const [memberRow] = await stored(reporter.id, target.id);
        assert.equal(memberRow.targetUserId, target.id);
        assert.equal(memberRow.groupId, groupId);
        assert.deepEqual(await counts(), before);
        // No automatic hiding: the reported photo and comment remain visible.
        const visible = await owner.agent
          .get(`/v1/photos/${targetPhoto}/comments`)
          .expect(200);
        assert.ok(
          visible.body.comments.some(
            (item: { id: string }) => item.id === targetComment
          )
        );
        assert.equal(
          (
            await admin.query('SELECT status FROM woori.photos WHERE id=$1', [
              targetPhoto,
            ])
          ).rows[0].status,
          'READY'
        );
      }
    );

    await t.test(
      'invisible, mismatched or nonexistent targets are indistinguishable 404s',
      async () => {
        const base = { reason: 'SPAM' };
        for (const [agent, body] of [
          [reporter.agent, { targetType: 'PHOTO', targetId: deletedPhoto }],
          [reporter.agent, { targetType: 'PHOTO', targetId: randomUUID() }],
          [
            reporter.agent,
            {
              targetType: 'PHOTO',
              targetId: targetPhoto,
              groupId: randomUUID(),
            },
          ],
          [reporter.agent, { targetType: 'PHOTO', targetId: targetComment }],
          [reporter.agent, { targetType: 'COMMENT', targetId: deletedComment }],
          [
            reporter.agent,
            {
              targetType: 'COMMENT',
              targetId: targetComment,
              groupId: randomUUID(),
            },
          ],
          [reporter.agent, { targetType: 'COMMENT', targetId: targetPhoto }],
          [
            reporter.agent,
            { targetType: 'USER', targetId: target.id, groupId: randomUUID() },
          ],
          [
            reporter.agent,
            { targetType: 'USER', targetId: outsider.id, groupId },
          ],
          [
            reporter.agent,
            { targetType: 'USER', targetId: leaver.id, groupId },
          ],
          [
            reporter.agent,
            { targetType: 'USER', targetId: removed.id, groupId },
          ],
          [outsider.agent, { targetType: 'PHOTO', targetId: targetPhoto }],
          [outsider.agent, { targetType: 'COMMENT', targetId: targetComment }],
          [
            outsider.agent,
            { targetType: 'USER', targetId: target.id, groupId },
          ],
          [leaver.agent, { targetType: 'PHOTO', targetId: targetPhoto }],
          [leaver.agent, { targetType: 'COMMENT', targetId: targetComment }],
          [removed.agent, { targetType: 'PHOTO', targetId: targetPhoto }],
          [removed.agent, { targetType: 'USER', targetId: target.id, groupId }],
        ] as const)
          await missing(agent, { ...base, ...body });
        // A group being deleted hides every target in it.
        await admin.query(
          "UPDATE woori.groups SET status='DELETING' WHERE id=$1",
          [groupId]
        );
        try {
          for (const body of [
            { targetType: 'PHOTO', targetId: reporterPhoto },
            { targetType: 'COMMENT', targetId: reporterComment },
            { targetType: 'USER', targetId: owner.id, groupId },
          ])
            await missing(target.agent, { ...base, ...body });
        } finally {
          await admin.query(
            "UPDATE woori.groups SET status='ACTIVE' WHERE id=$1",
            [groupId]
          );
        }
        for (const id of [deletedPhoto, deletedComment, outsider.id])
          assert.equal((await stored(reporter.id, id)).length, 0);
        for (const id of [reporterPhoto, reporterComment, owner.id])
          assert.equal((await stored(target.id, id)).length, 0);
      }
    );

    await t.test(
      'own photo, own comment and self reports are rejected',
      async () => {
        for (const body of [
          { targetType: 'PHOTO', targetId: reporterPhoto },
          { targetType: 'COMMENT', targetId: reporterComment },
          { targetType: 'USER', targetId: reporter.id, groupId },
        ]) {
          const result = await file(reporter.agent, {
            ...body,
            reason: 'OTHER',
          }).expect(400);
          assert.equal(result.body.code, 'REPORT_SELF_NOT_ALLOWED');
        }
      }
    );

    await t.test(
      'a repeated report returns the original record unchanged',
      async () => {
        const first = (await stored(reporter.id, targetPhoto))[0];
        const again = await file(reporter.agent, {
          targetType: 'PHOTO',
          targetId: targetPhoto,
          groupId,
          reason: 'SPAM',
          detail: '덮어쓰면 안 되는 내용',
        }).expect(200);
        assert.deepEqual(Object.keys(again.body).sort(), resultKeys);
        assert.equal(again.body.duplicate, true);
        assert.equal(again.body.id, first.id);
        assert.equal(again.body.reason, 'INAPPROPRIATE');
        const rows = await stored(reporter.id, targetPhoto);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].detail, first.detail);
        assert.equal(rows[0].reason, 'INAPPROPRIATE');
        // The same target reported by another member is a separate record.
        await file(owner.agent, {
          targetType: 'PHOTO',
          targetId: targetPhoto,
          reason: 'SPAM',
        }).expect(201);
      }
    );

    await t.test(
      'concurrent duplicate submissions store exactly one report and count once',
      async () => {
        // The limit counts stored reports in the last 24 hours exactly.
        const quota = async () =>
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.content_reports WHERE "reporterId"=$1 AND "createdAt" > now() - interval \'24 hours\'',
              [reporter.id]
            )
          ).rows[0].n as number;
        const before = await quota();
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            file(reporter.agent, {
              targetType: 'PHOTO',
              targetId: racePhoto,
              reason: 'SPAM',
            })
          )
        );
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          [200, 200, 200, 200, 200, 201]
        );
        assert.equal(new Set(results.map((result) => result.body.id)).size, 1);
        assert.equal(
          results.filter((result) => result.body.duplicate === false).length,
          1
        );
        assert.equal((await stored(reporter.id, racePhoto)).length, 1);
        assert.equal(await quota(), before + 1);
      }
    );

    await t.test('invalid report requests are rejected with 400', async () => {
      const valid = {
        targetType: 'PHOTO',
        targetId: targetPhoto,
        reason: 'SPAM',
      };
      for (const bad of [
        { targetType: 'ALBUM' },
        { targetType: 'photo' },
        { reason: 'ABUSE' },
        { reason: undefined },
        { targetId: 'not-a-uuid' },
        { targetType: 'USER', targetId: target.id },
        { groupId: null },
        { detail: '가'.repeat(501) },
        { detail: '널\u0000문자' },
        { detail: '이스케이프\u001b[2J' },
        { detail: 42 },
        { status: 'RESOLVED' },
        { reporterId: target.id },
        { targetUserId: owner.id },
      ])
        await file(heavy.agent, { ...valid, ...bad }).expect(400);
      assert.equal((await stored(heavy.id, targetPhoto)).length, 0);
    });

    await t.test(
      'the 21st stored report in 24 hours is rate limited for that reporter only',
      async () => {
        // Not-found and self attempts above/below never consume the quota.
        await missing(heavy.agent, {
          targetType: 'PHOTO',
          targetId: randomUUID(),
          reason: 'SPAM',
        });
        await file(heavy.agent, {
          targetType: 'USER',
          targetId: heavy.id,
          groupId,
          reason: 'SPAM',
        }).expect(400);
        const photos: string[] = [];
        for (let index = 0; index < 22; index++)
          photos.push(await photo(target.id));
        for (const id of photos.slice(0, 20))
          await file(heavy.agent, {
            targetType: 'PHOTO',
            targetId: id,
            reason: 'SPAM',
          }).expect(201);
        const limited = await file(heavy.agent, {
          targetType: 'PHOTO',
          targetId: photos[20],
          reason: 'SPAM',
        }).expect(429);
        assert.equal(limited.body.code, 'TOO_MANY_REQUESTS');
        // A repeated report is answered even when the window is full.
        const repeated = await file(heavy.agent, {
          targetType: 'PHOTO',
          targetId: photos[0],
          reason: 'OTHER',
        }).expect(200);
        assert.equal(repeated.body.duplicate, true);
        assert.equal(
          (
            await admin.query(
              'SELECT count(*)::int AS n FROM woori.content_reports WHERE "reporterId"=$1',
              [heavy.id]
            )
          ).rows[0].n,
          20
        );
        await file(reporter.agent, {
          targetType: 'PHOTO',
          targetId: photos[21],
          reason: 'SPAM',
        }).expect(201);
        // Exact rolling 24 hours: a report older than that frees one slot.
        await admin.query(
          'UPDATE woori.content_reports SET "createdAt"=now()-interval \'24 hours 1 minute\' WHERE "reporterId"=$1 AND "targetId"=$2',
          [heavy.id, photos[0]]
        );
        await file(heavy.agent, {
          targetType: 'PHOTO',
          targetId: photos[20],
          reason: 'SPAM',
        }).expect(201);
        await file(heavy.agent, {
          targetType: 'PHOTO',
          targetId: await photo(target.id),
          reason: 'SPAM',
        }).expect(429);
      }
    );

    await t.test(
      'members list only their own reports with status and without target content',
      async () => {
        const all = await reporter.agent.get('/v1/reports').expect(200);
        assert.equal(all.headers['cache-control'], 'no-store');
        assert.deepEqual(Object.keys(all.body).sort(), ['items', 'nextCursor']);
        const expected = (
          await admin.query(
            'SELECT id FROM woori.content_reports WHERE "reporterId"=$1 ORDER BY "createdAt" DESC, id DESC',
            [reporter.id]
          )
        ).rows.map((row: { id: string }) => row.id);
        assert.ok(expected.length >= 5);
        assert.deepEqual(
          all.body.items.map((item: { id: string }) => item.id),
          expected
        );
        for (const item of all.body.items)
          assert.deepEqual(Object.keys(item).sort(), itemKeys);
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const query: Record<string, string | number> = { limit: 2 };
          if (cursor) query.cursor = cursor;
          const page = await reporter.agent
            .get('/v1/reports')
            .query(query)
            .expect(200);
          assert.ok(page.body.items.length <= 2);
          seen.push(...page.body.items.map((item: { id: string }) => item.id));
          cursor = page.body.nextCursor;
        } while (cursor && seen.length < 100);
        assert.deepEqual(seen, expected);
        const others = (
          await admin.query(
            'SELECT id FROM woori.content_reports WHERE "reporterId"<>$1 LIMIT 1',
            [reporter.id]
          )
        ).rows[0].id as string;
        assert.ok(!expected.includes(others));
        for (const cursorId of [others, randomUUID()]) {
          const stale = await reporter.agent
            .get('/v1/reports')
            .query({ cursor: cursorId })
            .expect(404);
          assert.equal(stale.body.code, 'REPORT_NOT_FOUND');
        }
        for (const query of [
          { limit: 0 },
          { limit: 51 },
          { cursor: 'bad' },
          { reporterId: target.id },
        ])
          await reporter.agent.get('/v1/reports').query(query).expect(400);
        // Status changes come from the operator later and are shown read-only.
        await admin.query(
          'UPDATE woori.content_reports SET status=\'RESOLVED\', "resolvedAt"=now(), "updatedAt"=now() WHERE id=$1',
          [expected[0]]
        );
        const resolved = (await reporter.agent.get('/v1/reports').expect(200))
          .body.items[0];
        assert.equal(resolved.status, 'RESOLVED');
        assert.ok(!Number.isNaN(Date.parse(resolved.resolvedAt)));
        const emptyList = await outsider.agent.get('/v1/reports').expect(200);
        assert.deepEqual(emptyList.body, { items: [], nextCursor: null });
      }
    );

    await t.test(
      'members cannot read, cancel or change a report and admin stays closed',
      async () => {
        const id = (await stored(reporter.id, targetPhoto))[0].id as string;
        await reporter.agent.get(`/v1/reports/${id}`).expect(404);
        await mutate(reporter.agent.patch(`/v1/reports/${id}`))
          .send({ status: 'DISMISSED' })
          .expect(404);
        await mutate(reporter.agent.delete(`/v1/reports/${id}`)).expect(404);
        await mutate(reporter.agent.post(`/v1/reports/${id}/cancel`))
          .send({})
          .expect(404);
        for (const op of [
          reporter.agent.get('/v1/admin/reports'),
          mutate(reporter.agent.post(`/v1/admin/reports/${id}/resolve`)).send(
            {}
          ),
          mutate(reporter.agent.put(`/v1/admin/reports/${id}`)).send({
            status: 'RESOLVED',
          }),
        ]) {
          const result = await op.expect(403);
          assert.equal(result.body.code, 'ADMIN_AUTHENTICATION_REQUIRED');
        }
        assert.equal(
          (await stored(reporter.id, targetPhoto))[0].status,
          'RECEIVED'
        );
      }
    );

    await t.test(
      'reporter withdrawal keeps the report anonymously and erases only its detail',
      async () => {
        await file(withdrawer.agent, {
          targetType: 'PHOTO',
          targetId: targetPhoto,
          reason: 'PRIVACY',
          detail: '탈퇴 후 지워질 설명',
        }).expect(201);
        const [before] = await stored(withdrawer.id, targetPhoto);
        await admin.query(
          "UPDATE woori.content_reports SET status='REVIEWING' WHERE id=$1",
          [before.id]
        );
        await mutate(withdrawer.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        const [after] = await stored(withdrawer.id, targetPhoto);
        assert.equal(after.id, before.id);
        assert.equal(after.detail, null);
        assert.equal(after.status, 'REVIEWING');
        assert.equal(after.reason, 'PRIVACY');
        assert.equal(after.targetUserId, target.id);
        assert.equal(after.groupId, groupId);
        assert.ok(after.updatedAt >= before.updatedAt);
        // Other reporters' details are untouched.
        assert.equal(
          (await stored(reporter.id, targetPhoto))[0].detail,
          '부적절한 사진이에요.\n확인 부탁드려요.'
        );
        await withdrawer.agent.get('/v1/reports').expect(401);
      }
    );

    await t.test(
      'reports about a withdrawn member and their retained content remain',
      async () => {
        const photoReport = (
          await file(reporter.agent, {
            targetType: 'PHOTO',
            targetId: departingPhoto,
            reason: 'OTHER',
            detail: '탈퇴 회원 사진',
          }).expect(201)
        ).body;
        const memberReport = (
          await file(reporter.agent, {
            targetType: 'USER',
            targetId: departing.id,
            groupId,
            reason: 'HARASSMENT',
          }).expect(201)
        ).body;
        await mutate(departing.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        for (const id of [departingPhoto, departing.id]) {
          const [row] = await stored(reporter.id, id);
          assert.equal(row.targetUserId, departing.id);
          assert.equal(row.status, 'RECEIVED');
        }
        assert.equal(
          (await stored(reporter.id, departingPhoto))[0].detail,
          '탈퇴 회원 사진'
        );
        const listed = (
          await reporter.agent
            .get('/v1/reports')
            .query({ limit: 50 })
            .expect(200)
        ).body.items.map((item: { id: string }) => item.id);
        assert.ok(listed.includes(photoReport.id));
        assert.ok(listed.includes(memberReport.id));
        // Retained shared content stays reportable; the departed member does not.
        await file(reporter.agent, {
          targetType: 'PHOTO',
          targetId: departingLater,
          reason: 'SPAM',
        }).expect(201);
        assert.equal(
          (await stored(reporter.id, departingLater))[0].targetUserId,
          departing.id
        );
        await missing(target.agent, {
          targetType: 'USER',
          targetId: departing.id,
          groupId,
          reason: 'SPAM',
        });
      }
    );

    await t.test(
      'a report racing its reporter’s withdrawal never keeps the detail',
      async () => {
        for (let round = 0; round < 3; round++) {
          const racer = await signup(`r_race${round}`);
          await app
            .get(InvitationsRepository)
            .join({ codeHash: hashInvitation(invitation.code) }, racer.id);
          const results = await Promise.allSettled([
            app
              .get(AccountDeletionRepository)
              .delete(racer.id, racer.sessionHash, fixtureHash),
            app.get(ReportsRepository).create(racer.id, {
              targetType: 'PHOTO',
              targetId: targetPhoto,
              reason: 'OTHER',
              detail: '경합 중 설명',
            }),
          ]);
          assert.equal(results[0].status, 'fulfilled');
          if (results[1].status === 'rejected')
            assert.equal(results[1].reason?.getStatus?.(), 404);
          assert.equal(
            (
              await admin.query('SELECT status FROM woori.users WHERE id=$1', [
                racer.id,
              ])
            ).rows[0].status,
            'DELETED'
          );
          for (const row of await stored(racer.id, targetPhoto))
            assert.equal(row.detail, null);
        }
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
