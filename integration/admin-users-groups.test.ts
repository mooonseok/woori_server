import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import type { Response, Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import { RecoveryRepository } from '../src/domain/auth/recovery.repository';
import { InvitationsRepository } from '../src/domain/invitations/invitations.repository';
import { hashInvitation } from '../src/domain/invitations/invitation-policy';
import { PhotosRepository } from '../src/domain/photos/photos.repository';
import { PhotoProcessingService } from '../src/worker/photo-processing/photo-processing.service';
import { PushDispatchRepository } from '../src/worker/push/push-dispatch.repository';
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
const LOOPBACK = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

test('isolated PostgreSQL: admin member and group management, suspension, deletion and metrics', async (t) => {
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
  const password = `member-ops-pass-${suffix}`;
  const newPassword = `member-ops-new-${suffix}`;
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const query = async (sql: string, values: unknown[] = []) =>
      (await owner.query(sql, values)).rows;
    const clearLimits = (scopes: string[], windowMs: number) =>
      owner.query('DELETE FROM woori.rate_limit_buckets WHERE id = ANY($1)', [
        LOOPBACK.flatMap((ip) =>
          scopes.map(
            (scope) =>
              rateLimitKey('auth', `${scope}:${ip}`, new Date(), windowMs).id
          )
        ),
      ]);
    // Earlier admin suites in this run share the per-IP admin budgets.
    await clearLimits(['admin-login-ip', 'admin-mfa-ip'], 15 * MINUTE);
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

    // Admin with an MFA-verified session.
    const adminClient = await owner.connect();
    const admin = await createAdminAccount(adminClient, {
      username: `members_${suffix}`,
      displayName: '회원 운영자',
      password,
    }).finally(() => adminClient.release());
    const secret = generateTotpSecret();
    await owner.query(
      'UPDATE woori.admin_accounts SET "totpSecretCiphertext"=$2,"totpEnabledAt"=now() WHERE id=$1',
      [admin.id, encryptTotpSecret(secret, totpKey, admin.id)]
    );
    const login = () =>
      adminMutation(api.post('/v1/admin/auth/login'))
        .send({ username: admin.username, password })
        .expect(200);
    const pending = tokenOf(await login());
    const token = tokenOf(
      await as(
        adminMutation(api.post('/v1/admin/auth/mfa/verify')),
        tokenOf(await login())
      )
        .send({ code: totpCode(secret, Date.now()) })
        .expect(200)
    );
    const get = (path: string) => as(api.get(path), token);
    const post = (path: string) => as(adminMutation(api.post(path)), token);
    const patch = (path: string) => as(adminMutation(api.patch(path)), token);
    const staleReauth = () =>
      owner.query(
        `UPDATE woori.admin_sessions SET "reauthAt"=now()-interval '11 minutes' WHERE "tokenHash"=$1`,
        [hashToken(token)]
      );
    const reauthenticate = async () => {
      await owner.query(
        'UPDATE woori.admin_accounts SET "totpLastUsedStep"=NULL WHERE id=$1',
        [admin.id]
      );
      await post('/v1/admin/auth/reauth')
        .send({ password, code: totpCode(secret, Date.now()) })
        .expect(200);
    };
    const audits = (action: string, targetId: string) =>
      query(
        'SELECT * FROM woori.admin_audit_logs WHERE action=$1 AND "targetId"=$2 ORDER BY "createdAt",id',
        [action, targetId]
      );

    // Members.
    const fixtureHash = await hashPassword(password);
    const signup = async (label: string, displayName = label) => {
      const agent = request.agent(app.getHttpServer());
      const sessionToken = createToken();
      const username = `${label}_${suffix}`;
      const email = `${label}.${suffix}@example.test`;
      const user = await app.get(AuthRepository).createUser(
        {
          username,
          email,
          displayName,
          passwordHash: fixtureHash,
          verifiedAt: new Date(),
        },
        hashToken(sessionToken)
      );
      agent.set('Cookie', `woori_session=${sessionToken}`);
      return {
        agent,
        id: user.id,
        username,
        email,
        displayName,
        sessionToken,
        sessionHash: hashToken(sessionToken),
      };
    };
    const head = await signup('mg_head', `가족대표 ${suffix}`),
      m1 = await signup('mg_one', `첫째 ${suffix}`),
      m2 = await signup('mg_two', `둘째 ${suffix}`),
      leaver = await signup('mg_leaver', `떠날 사람 ${suffix}`),
      m3 = await signup('mg_three', `셋째 ${suffix}`),
      heir = await signup('mg_heir', `물려받을 사람 ${suffix}`);
    const createGroup = async (by: { agent: Agent }, name: string) =>
      (
        await memberMutation(by.agent.post('/v1/groups'))
          .send({ name })
          .expect(201)
      ).body.group.id as string;
    const join = async (
      groupId: string,
      by: { agent: Agent },
      ids: string[]
    ) => {
      const invitation = (
        await memberMutation(by.agent.post(`/v1/groups/${groupId}/invitations`))
          .send({ maxUses: 10 })
          .expect(201)
      ).body;
      for (const id of ids)
        await app
          .get(InvitationsRepository)
          .join({ codeHash: hashInvitation(invitation.code) }, id);
    };
    const groupName = `관리 그룹 ${suffix}`;
    const groupId = await createGroup(head, groupName);
    await join(groupId, head, [m1.id, m2.id, leaver.id, m3.id]);
    const leaverGroupName = `떠날 사람의 그룹 ${suffix}`;
    const leaverGroup = await createGroup(leaver, leaverGroupName);
    await join(leaverGroup, leaver, [heir.id]);
    const albumId = (
      await memberMutation(head.agent.post(`/v1/groups/${groupId}/albums`))
        .send({ title: '운영 앨범' })
        .expect(201)
    ).body.album.id as string;
    const album = `/v1/groups/${groupId}/albums/${albumId}`;
    const photo = async (uploaderId: string, minutesAgo: number) => {
      const id = randomUUID();
      await owner.query(
        'INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,bytes,width,height,"createdAt") VALUES($1,$2,$3,$4,\'READY\',2048,640,480,now()-make_interval(mins=>$5))',
        [id, groupId, albumId, uploaderId, minutesAgo]
      );
      await owner.query(
        'UPDATE woori.groups SET "usedBytes"="usedBytes"+2048 WHERE id=$1',
        [groupId]
      );
      return id;
    };
    const m1Photo = await photo(m1.id, 30);
    const leaverPhoto = await photo(leaver.id, 20);
    const m2Photo = await photo(m2.id, 10);
    const comment = async (
      by: { agent: Agent },
      photoId: string,
      body: string
    ) =>
      (
        await memberMutation(by.agent.post(`/v1/photos/${photoId}/comments`))
          .send({ body })
          .expect(201)
      ).body.comment.id as string;
    const m1Comment = await comment(m1, m2Photo, `첫째의 댓글 ${suffix}`);
    const m2Comment = await comment(m2, m1Photo, `둘째의 댓글 ${suffix}`);
    await memberMutation(m2.agent.post('/v1/reports'))
      .send({ targetType: 'USER', targetId: m1.id, groupId, reason: 'SPAM' })
      .expect(201);
    await memberMutation(m1.agent.post('/v1/reports'))
      .send({ targetType: 'COMMENT', targetId: m2Comment, reason: 'OTHER' })
      .expect(201);
    await memberMutation(m1.agent.post('/v1/inquiries'))
      .send({ category: 'ACCOUNT', title: '첫째 문의', body: '문의 본문' })
      .expect(201);
    let suspendedRoster: string[] = [];
    const memberPhotoIds = async (agent: Agent) =>
      (await agent.get(`${album}/photos`).expect(200)).body.photos.map(
        (item: { id: string }) => item.id
      );

    await t.test(
      'every new route needs an MFA-verified admin session, the admin web origin and re-auth where sensitive',
      async () => {
        const id = randomUUID();
        const routes: Array<['get' | 'post' | 'patch', string, object?]> = [
          ['get', '/v1/admin/users'],
          ['get', `/v1/admin/users/${id}`],
          [
            'patch',
            `/v1/admin/users/${id}`,
            { displayName: '이름', reason: '이름 변경 사유' },
          ],
          [
            'post',
            `/v1/admin/users/${id}/suspend`,
            { reason: '정지 사유입니다' },
          ],
          [
            'post',
            `/v1/admin/users/${id}/unsuspend`,
            { reason: '해제 사유입니다' },
          ],
          [
            'post',
            `/v1/admin/users/${id}/delete`,
            { reason: '삭제 사유입니다', confirmUsername: 'x' },
          ],
          ['get', '/v1/admin/groups'],
          ['get', `/v1/admin/groups/${id}`],
          ['get', `/v1/admin/groups/${id}/albums/${id}/photos`],
          ['get', '/v1/admin/metrics'],
        ];
        for (const [method, path, body] of routes) {
          const send = (op: Test) => (body ? op.send(body) : op);
          const asMember = await send(
            method === 'get'
              ? head.agent.get(path)
              : memberMutation(head.agent[method](path))
          ).expect(401);
          assert.equal(
            asMember.body.code,
            'ADMIN_AUTHENTICATION_REQUIRED',
            path
          );
          const asPending = await send(
            as(
              method === 'get'
                ? api.get(path)
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
        await staleReauth();
        for (const [path, body] of [
          ['suspend', { reason: '정지 사유입니다' }],
          ['unsuspend', { reason: '해제 사유입니다' }],
          [
            'delete',
            { reason: '삭제 사유입니다', confirmUsername: m1.username },
          ],
        ] as const) {
          const res = await post(`/v1/admin/users/${m1.id}/${path}`)
            .send(body)
            .expect(403);
          assert.equal(res.body.code, 'ADMIN_REAUTH_REQUIRED', path);
        }
        assert.equal(
          (
            await query(
              'SELECT status::text AS status FROM woori.users WHERE id=$1',
              [m1.id]
            )
          )[0].status,
          'ACTIVE'
        );
        await reauthenticate();
      }
    );

    await t.test(
      'member list: search, filters, masking, paging and audited detail with counts',
      async () => {
        const search = await get(`/v1/admin/users?query=MG_&limit=50`).expect(
          200
        );
        const ours = search.body.items.filter((item: { username: string }) =>
          item.username.endsWith(`_${suffix}`)
        );
        assert.deepEqual(
          ours.map((item: { id: string }) => item.id).sort(),
          [head.id, m1.id, m2.id, leaver.id, heir.id, m3.id].sort()
        );
        const one = ours.find((item: { id: string }) => item.id === m1.id);
        assert.deepEqual(Object.keys(one).sort(), [
          'activeGroupCount',
          'createdAt',
          'displayName',
          'emailMasked',
          'emailVerified',
          'id',
          'status',
          'username',
        ]);
        assert.equal(one.emailMasked, 'mg***@example.test');
        assert.equal(one.emailVerified, true);
        assert.equal(one.activeGroupCount, 1);
        assert.equal(
          (
            await get(
              `/v1/admin/users?query=${encodeURIComponent(`첫째 ${suffix}`)}`
            ).expect(200)
          ).body.items
            .map((item: { id: string }) => item.id)
            .join(),
          m1.id
        );
        // LIKE wildcards are matched literally.
        assert.equal(
          (
            await get('/v1/admin/users?query=%25&limit=50').expect(200)
          ).body.items.filter((item: { username: string }) =>
            item.username.endsWith(`_${suffix}`)
          ).length,
          0
        );
        await get(`/v1/admin/users?query=${'x'.repeat(65)}`).expect(400);
        await get('/v1/admin/users?status=BANNED').expect(400);
        assert.equal(
          (await get(`/v1/admin/users?cursor=${randomUUID()}`).expect(400)).body
            .code,
          'ADMIN_USER_CURSOR_INVALID'
        );
        const paged: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Response = await get(
            `/v1/admin/users?query=mg_&limit=1${cursor ? `&cursor=${cursor}` : ''}`
          ).expect(200);
          paged.push(...page.body.items.map((item: { id: string }) => item.id));
          cursor = page.body.nextCursor;
        } while (cursor);
        assert.equal(new Set(paged).size, paged.length);
        assert.ok(
          [head.id, m1.id, m2.id, leaver.id, heir.id, m3.id].every((id) =>
            paged.includes(id)
          )
        );

        const detail = await get(`/v1/admin/users/${m1.id}`).expect(200);
        assert.deepEqual(detail.body.counts, {
          photos: 1,
          comments: 1,
          openReportsAgainst: 1,
          openReportsFiled: 1,
          inquiries: 1,
        });
        assert.deepEqual(detail.body.memberships, [
          {
            group: { id: groupId, name: groupName, status: 'ACTIVE' },
            role: 'MEMBER',
            status: 'ACTIVE',
            joinedAt: detail.body.memberships[0].joinedAt,
          },
        ]);
        assert.ok(detail.body.memberships[0].joinedAt);
        for (const forbidden of ['email', 'passwordHash', 'sessions'])
          assert.equal(detail.body[forbidden], undefined, forbidden);
        assert.equal((await audits('ADMIN_USER_VIEWED', m1.id)).length, 1);
        assert.equal(
          (await get(`/v1/admin/users/${randomUUID()}`).expect(404)).body.code,
          'ADMIN_USER_NOT_FOUND'
        );
      }
    );

    await t.test('rename is audited without names', async () => {
      await patch(`/v1/admin/users/${m2.id}`)
        .send({ displayName: '새 이름', reason: '짧음' })
        .expect(400);
      await patch(`/v1/admin/users/${m2.id}`)
        .send({ displayName: '이름‮', reason: '부적절한 이름 정리' })
        .expect(400);
      await patch(`/v1/admin/users/${m2.id}`)
        .send({
          displayName: '새 이름',
          reason: '부적절한 이름 정리',
          status: 'ACTIVE',
        })
        .expect(400);
      const renamed = await patch(`/v1/admin/users/${m2.id}`)
        .send({
          displayName: `  정리된 이름 ${suffix} `,
          reason: '부적절한 이름 정리',
        })
        .expect(200);
      assert.equal(renamed.body.displayName, `정리된 이름 ${suffix}`);
      assert.equal(
        (await m2.agent.get('/v1/auth/me').expect(200)).body.user.displayName,
        `정리된 이름 ${suffix}`
      );
      const row = (await audits('ADMIN_USER_RENAMED', m2.id))[0];
      assert.equal(row.reason, '부적절한 이름 정리');
      assert.doesNotMatch(JSON.stringify(row.metadata), /이름|둘째/);
    });

    await t.test(
      'suspension blocks every member route, login, notifications, push and uploads but keeps shared content',
      async () => {
        // Before suspension: a notification, a bound push installation with an
        // in-flight delivery, and an accepted (queued) upload for m1.
        const notification = (
          await query(
            `SELECT id FROM woori.notifications WHERE "recipientId"=$1 AND "targetId"=$2`,
            [m1.id, m2Comment]
          )
        )[0];
        assert.ok(notification, 'comment on m1 photo notified m1');
        const session = (
          await query('SELECT id FROM woori.sessions WHERE "tokenHash"=$1', [
            m1.sessionHash,
          ])
        )[0].id;
        const installation = randomUUID();
        await owner.query(
          'INSERT INTO woori.push_installations(id,"userId",provider,"sessionId","endpointCiphertext","endpointHash","boundAt") VALUES($1,$2,\'WEB\',$3,\'fixture\',$4,now()-interval \'1 hour\')',
          [installation, m1.id, session, randomBytes(32).toString('hex')]
        );
        const delivery = randomUUID();
        await owner.query(
          'INSERT INTO woori.notification_deliveries(id,"notificationId","installationId","deliveryKey",status,"leaseUntil","leaseToken") VALUES($1,$2,$3,$4,\'RUNNING\',now()+interval \'1 minute\',$5)',
          [
            delivery,
            notification.id,
            installation,
            `admin-fixture:${delivery}`,
            randomUUID(),
          ]
        );
        const dispatch = new PushDispatchRepository(app.get(PrismaService));
        assert.ok(
          await dispatch.eligibility(delivery),
          'eligible before suspension'
        );
        const queued = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,"stagingKey","uploadMime","uploadBytes","reservedBytes","processingQueuedAt","processingAvailableAt","processingDeadlineAt") VALUES($1,$2,$3,$4,'PROCESSING',$5,'image/png',5,1048576,now(),now(),now()+interval '1 day')`,
          [queued, groupId, albumId, m1.id, `staging/${queued}`]
        );

        const suspended = await post(`/v1/admin/users/${m1.id}/suspend`)
          .send({ reason: '반복 신고 확인 후 정지' })
          .expect(200);
        assert.equal(suspended.body.status, 'SUSPENDED');
        await post(`/v1/admin/users/${m1.id}/suspend`)
          .send({ reason: '반복 신고 확인 후 정지' })
          .expect(200);
        const suspendAudit = await audits('ADMIN_USER_SUSPENDED', m1.id);
        assert.equal(
          suspendAudit.length,
          1,
          'idempotent suspension audited once'
        );
        assert.equal(suspendAudit[0].reason, '반복 신고 확인 후 정지');

        // The old member cookie no longer works on any route family.
        for (const path of [
          '/v1/auth/me',
          '/v1/auth/account-deletion',
          '/v1/groups',
          `/v1/groups/${groupId}`,
          `/v1/groups/${groupId}/members`,
          `/v1/groups/${groupId}/albums`,
          `/v1/groups/${groupId}/memories`,
          `${album}/photos`,
          `${album}/photos/${m1Photo}/content`,
          `/v1/photos/${m1Photo}/comments`,
          `/v1/photos/${m1Photo}/reactions`,
          '/v1/notifications',
          '/v1/notifications/preferences',
          '/v1/notices',
          '/v1/inquiries',
          '/v1/reports',
          '/v1/blocks',
          `/v1/push/deliveries/${delivery}/display`,
        ]) {
          const res = await m1.agent.get(path).expect(401);
          assert.equal(res.body.code, 'AUTHENTICATION_REQUIRED', path);
        }
        await memberMutation(m1.agent.post(`/v1/photos/${m2Photo}/comments`))
          .send({ body: '정지 후 댓글' })
          .expect(401);
        // Login: the correct password reveals the suspension, a wrong one does not.
        const blocked = await memberMutation(api.post('/v1/auth/login'))
          .send({ username: m1.username, password })
          .expect(403);
        assert.equal(blocked.body.code, 'ACCOUNT_SUSPENDED');
        assert.equal(
          blocked.body.message,
          '이용이 정지된 계정이에요. 문의가 필요하면 운영자에게 연락해 주세요.'
        );
        assert.equal(
          (
            await memberMutation(api.post('/v1/auth/login'))
              .send({ username: m1.username, password: `${password}-x` })
              .expect(401)
          ).body.code,
          'INVALID_CREDENTIALS'
        );
        // Credentials were revoked atomically; push is no longer eligible.
        assert.equal(
          (
            await query(
              'SELECT count(*)::int AS n FROM woori.sessions WHERE "userId"=$1 AND "revokedAt" IS NULL',
              [m1.id]
            )
          )[0].n,
          0
        );
        assert.equal(await dispatch.eligibility(delivery), null);
        // New activity does not notify the suspended member.
        const later = await comment(m2, m1Photo, `정지 후 활동 ${suffix}`);
        assert.equal(
          (
            await query(
              'SELECT count(*)::int AS n FROM woori.notifications WHERE "recipientId"=$1 AND "targetId"=$2',
              [m1.id, later]
            )
          )[0].n,
          0
        );
        // The accepted upload ends FAILED without processing.
        const storage = app.get(MediaStorageService);
        const processed: string[] = [];
        Object.assign(storage, {
          enabled: () => true,
          process: async (key: string) => {
            processed.push(key);
            throw new Error('fixture storage does not process');
          },
          cleanup: async () => undefined,
        });
        const worker = new PhotoProcessingService(
          app.get(PhotosRepository),
          storage
        );
        for (let i = 0; i < 5; i++) {
          const state = (
            await query(
              'SELECT status::text AS status FROM woori.photos WHERE id=$1',
              [queued]
            )
          )[0];
          if (state.status !== 'PROCESSING') break;
          await worker.runBatch(1);
        }
        const failed = (
          await query(
            'SELECT status::text AS status,"processingErrorCode","reservedBytes" FROM woori.photos WHERE id=$1',
            [queued]
          )
        )[0];
        assert.deepEqual(failed, {
          status: 'FAILED',
          processingErrorCode: 'UPLOADER_INACTIVE',
          reservedBytes: '0',
        });
        assert.ok(!processed.includes(`staging/${queued}`));
        // Shared content stays visible to the group.
        assert.ok((await memberPhotoIds(m2.agent)).includes(m1Photo));
        assert.ok(
          (
            await m2.agent.get(`/v1/photos/${m2Photo}/comments`).expect(200)
          ).body.comments.some((item: { id: string }) => item.id === m1Comment)
        );
        // Roster policy: suspended members stay listed with the same item shape
        // and count, ownership cannot go to them, and the owner can remove them.
        const roster = async () => {
          const res = await head.agent
            .get(`/v1/groups/${groupId}/members?limit=50`)
            .expect(200);
          for (const item of res.body.members)
            assert.deepEqual(Object.keys(item).sort(), [
              'blockedByMe',
              'displayName',
              'joinedAt',
              'role',
              'userId',
            ]);
          return res.body.members
            .map((item: { userId: string }) => item.userId)
            .sort();
        };
        assert.deepEqual(
          await roster(),
          [head.id, m1.id, m2.id, leaver.id, m3.id].sort()
        );
        assert.equal(
          (await head.agent.get(`/v1/groups/${groupId}`).expect(200)).body.group
            .members,
          5
        );
        const transfer = await memberMutation(
          head.agent.post(`/v1/groups/${groupId}/ownership`)
        )
          .send({ userId: m1.id })
          .expect(409);
        assert.equal(transfer.body.code, 'GROUP_MEMBER_UNAVAILABLE');
        await post(`/v1/admin/users/${m3.id}/suspend`)
          .send({ reason: '내보내기 전 정지' })
          .expect(200);
        assert.ok((await roster()).includes(m3.id));
        await memberMutation(
          head.agent.delete(`/v1/groups/${groupId}/members/${m3.id}`)
        ).expect(204);
        assert.ok(!(await roster()).includes(m3.id));
        suspendedRoster = await roster();
        assert.ok(suspendedRoster.includes(m1.id));
        const listed = await get(
          '/v1/admin/users?status=SUSPENDED&limit=50'
        ).expect(200);
        assert.ok(
          listed.body.items.some((item: { id: string }) => item.id === m1.id)
        );

        // Recovery may reset the password but never reactivates or signs in.
        const reset = createToken();
        assert.equal(
          await app
            .get(RecoveryRepository)
            .issue(m1.id, m1.displayName, m1.email, hashToken(reset)),
          true
        );
        const confirmed = await memberMutation(
          api.post('/v1/auth/recovery/password/confirm')
        )
          .send({ token: reset, newPassword })
          .expect(204);
        assert.equal(confirmed.headers['set-cookie'], undefined);
        assert.equal(
          (
            await query(
              'SELECT status::text AS status FROM woori.users WHERE id=$1',
              [m1.id]
            )
          )[0].status,
          'SUSPENDED'
        );
        assert.equal(
          (
            await memberMutation(api.post('/v1/auth/login'))
              .send({ username: m1.username, password: newPassword })
              .expect(403)
          ).body.code,
          'ACCOUNT_SUSPENDED'
        );
        await clearLimits(['recovery-confirm-ip'], 15 * MINUTE);
      }
    );

    await t.test(
      'unsuspend restores login but not the revoked sessions',
      async () => {
        await staleReauth();
        await post(`/v1/admin/users/${m1.id}/unsuspend`)
          .send({ reason: '이의 신청 확인 후 해제' })
          .expect(403);
        await reauthenticate();
        const restored = await post(`/v1/admin/users/${m1.id}/unsuspend`)
          .send({ reason: '이의 신청 확인 후 해제' })
          .expect(200);
        assert.equal(restored.body.status, 'ACTIVE');
        // Unsuspension does not change the roster.
        assert.deepEqual(
          (
            await head.agent
              .get(`/v1/groups/${groupId}/members?limit=50`)
              .expect(200)
          ).body.members
            .map((item: { userId: string }) => item.userId)
            .sort(),
          suspendedRoster
        );
        assert.equal(
          (
            await post(`/v1/admin/users/${m1.id}/unsuspend`)
              .send({ reason: '다시 해제 시도' })
              .expect(409)
          ).body.code,
          'ADMIN_USER_NOT_SUSPENDED'
        );
        await m1.agent.get('/v1/auth/me').expect(401);
        const relogin = request.agent(app.getHttpServer());
        await memberMutation(relogin.post('/v1/auth/login'))
          .send({ username: m1.username, password: newPassword })
          .expect(200);
        await relogin.get('/v1/auth/me').expect(200);
        const audit = (await audits('ADMIN_USER_UNSUSPENDED', m1.id))[0];
        assert.equal(audit.reason, '이의 신청 확인 후 해제');
        assert.deepEqual(audit.metadata, {
          previousStatus: 'SUSPENDED',
          status: 'ACTIVE',
        });
      }
    );

    await t.test(
      'admin deletion reuses the member withdrawal core: ownership preflight, erasure parity and isolation',
      async () => {
        // Private and shared data of the member to delete.
        await memberMutation(leaver.agent.post('/v1/inquiries'))
          .send({ category: 'OTHER', title: '떠나기 전 문의', body: '본문' })
          .expect(201);
        const filed = (
          await memberMutation(leaver.agent.post('/v1/reports'))
            .send({
              targetType: 'COMMENT',
              targetId: m2Comment,
              reason: 'HARASSMENT',
              detail: '떠나는 사람의 신고 내용',
            })
            .expect(201)
        ).body.id as string;
        await memberMutation(leaver.agent.put(`/v1/blocks/${m2.id}`)).expect(
          200
        );
        const incomplete = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,"stagingKey","uploadMime","uploadBytes","reservedBytes","uploadExpiresAt") VALUES($1,$2,$3,$4,'PENDING',$5,'image/png',5,1048576,now()+interval '10 minutes')`,
          [incomplete, groupId, albumId, leaver.id, `staging/${incomplete}`]
        );
        const reason = { reason: '본인 요청에 따른 계정 삭제' };
        const mismatch = await post(`/v1/admin/users/${leaver.id}/delete`)
          .send({ ...reason, confirmUsername: m2.username })
          .expect(400);
        assert.equal(mismatch.body.code, 'ADMIN_CONFIRM_USERNAME_MISMATCH');
        const owned = await post(`/v1/admin/users/${leaver.id}/delete`)
          .send({ ...reason, confirmUsername: leaver.username.toUpperCase() })
          .expect(409);
        assert.equal(owned.body.code, 'ADMIN_OWNED_GROUPS_REMAIN');
        assert.deepEqual(owned.body.groups, [
          { id: leaverGroup, name: leaverGroupName },
        ]);
        assert.equal(
          (
            await query(
              'SELECT status::text AS status FROM woori.users WHERE id=$1',
              [leaver.id]
            )
          )[0].status,
          'ACTIVE'
        );
        await memberMutation(
          leaver.agent.post(`/v1/groups/${leaverGroup}/ownership`)
        )
          .send({ userId: heir.id })
          .expect(200);
        const deleted = await post(`/v1/admin/users/${leaver.id}/delete`)
          .send({ ...reason, confirmUsername: leaver.username })
          .expect(200);
        assert.equal(deleted.body.status, 'DELETED');
        assert.equal(deleted.body.displayName, '탈퇴한 회원');
        assert.equal(deleted.body.emailMasked, null);
        assert.deepEqual(deleted.body.counts, {
          photos: 1,
          comments: 0,
          openReportsAgainst: 0,
          openReportsFiled: 1,
          inquiries: 0,
        });
        // Same erasure as member withdrawal.
        const user = (
          await query(
            'SELECT username,email,"displayName","passwordHash",status::text AS status FROM woori.users WHERE id=$1',
            [leaver.id]
          )
        )[0];
        assert.match(user.username, /^deleted\./);
        assert.match(user.email, /@deleted\.invalid$/);
        assert.equal(user.passwordHash, '');
        const remaining = (
          await query(
            `SELECT
              (SELECT count(*)::int FROM woori.sessions WHERE "userId"=$1) AS sessions,
              (SELECT count(*)::int FROM woori.inquiries WHERE "userId"=$1) AS inquiries,
              (SELECT count(*)::int FROM woori.user_blocks WHERE "blockerId"=$1) AS blocks,
              (SELECT count(*)::int FROM woori.memberships WHERE "userId"=$1 AND status='ACTIVE') AS memberships,
              (SELECT detail FROM woori.content_reports WHERE id=$2) AS detail,
              (SELECT "deletedAt" IS NOT NULL FROM woori.photos WHERE id=$3) AS "incompleteDeleted",
              (SELECT status::text FROM woori.photos WHERE id=$4) AS "sharedPhoto"`,
            [leaver.id, filed, incomplete, leaverPhoto]
          )
        )[0];
        assert.deepEqual(remaining, {
          sessions: 0,
          inquiries: 0,
          blocks: 0,
          memberships: 0,
          detail: null,
          incompleteDeleted: true,
          sharedPhoto: 'READY',
        });
        // Shared content stays, attributed to '탈퇴한 회원'.
        const shared = (
          await m2.agent.get(`${album}/photos`).expect(200)
        ).body.photos.find((item: { id: string }) => item.id === leaverPhoto);
        assert.equal(shared.uploader.displayName, '탈퇴한 회원');
        // The anonymized reporter is distinguishable by status in the admin report.
        const report = await get(`/v1/admin/reports/${filed}`).expect(200);
        assert.equal(report.body.reporter.status, 'DELETED');
        assert.equal(report.body.detail, null);
        const audit = (await audits('ADMIN_USER_DELETED', leaver.id))[0];
        assert.equal(audit.reason, '본인 요청에 따른 계정 삭제');
        assert.deepEqual(audit.metadata, {
          previousStatus: 'ACTIVE',
          status: 'DELETED',
        });
        assert.doesNotMatch(JSON.stringify(audit), new RegExp(leaver.username));
        // Deleted accounts: listed only on request, no further changes.
        assert.ok(
          !(
            await get('/v1/admin/users?query=mg_&limit=50').expect(200)
          ).body.items.some((item: { id: string }) => item.id === leaver.id)
        );
        assert.ok(
          (
            await get('/v1/admin/users?status=DELETED&limit=50').expect(200)
          ).body.items.some(
            (item: { id: string; emailMasked: string | null }) =>
              item.id === leaver.id && item.emailMasked === null
          )
        );
        for (const [method, path, body, code] of [
          [
            'post',
            'delete',
            { ...reason, confirmUsername: user.username },
            'ADMIN_USER_ALREADY_DELETED',
          ],
          ['post', 'suspend', reason, 'ADMIN_USER_NOT_SUSPENDABLE'],
          [
            'patch',
            '',
            { displayName: '복구', reason: '이름 복구 시도' },
            'ADMIN_USER_ALREADY_DELETED',
          ],
        ] as const) {
          const op =
            method === 'post'
              ? post(`/v1/admin/users/${leaver.id}/${path}`)
              : patch(`/v1/admin/users/${leaver.id}`);
          assert.equal((await op.send(body).expect(409)).body.code, code, path);
        }
        // A fresh signup with the same username and email is a separate account.
        const fresh = await app.get(AuthRepository).createUser(
          {
            username: leaver.username,
            email: leaver.email,
            displayName: '새 가입자',
            passwordHash: fixtureHash,
          },
          hashToken(createToken())
        );
        assert.notEqual(fresh.id, leaver.id);
        assert.equal(
          (await get(`/v1/admin/users/${fresh.id}`).expect(200)).body.counts
            .inquiries,
          0
        );
        // A suspended member can be deleted as well.
        await post(`/v1/admin/users/${heir.id}/suspend`)
          .send({ reason: '삭제 전 정지 확인' })
          .expect(200);
        const ownerOfTransferred = await post(
          `/v1/admin/users/${heir.id}/delete`
        )
          .send({ ...reason, confirmUsername: heir.username })
          .expect(409);
        assert.equal(ownerOfTransferred.body.code, 'ADMIN_OWNED_GROUPS_REMAIN');
        const suspendedDelete = await post(`/v1/admin/users/${m1.id}/suspend`)
          .send({ reason: '삭제 전 정지 확인' })
          .expect(200);
        assert.equal(suspendedDelete.body.status, 'SUSPENDED');
        await post(`/v1/admin/users/${m1.id}/delete`)
          .send({ ...reason, confirmUsername: m1.username })
          .expect(200);
        assert.equal(
          (await audits('ADMIN_USER_DELETED', m1.id))[0].metadata
            .previousStatus,
          'SUSPENDED'
        );
      }
    );

    await t.test(
      'groups: list, audited detail and album photo metadata without bytes',
      async () => {
        const list = await get(
          `/v1/admin/groups?query=${encodeURIComponent(suffix)}&limit=50`
        ).expect(200);
        const ids = list.body.items.map((item: { id: string }) => item.id);
        assert.deepEqual(ids.sort(), [groupId, leaverGroup].sort());
        const group = list.body.items.find(
          (item: { id: string }) => item.id === groupId
        );
        assert.deepEqual(Object.keys(group).sort(), [
          'albumCount',
          'createdAt',
          'id',
          'memberCount',
          'name',
          'owner',
          'photoCount',
          'quotaBytes',
          'status',
          'usedBytes',
        ]);
        assert.deepEqual(group.owner, {
          id: head.id,
          displayName: head.displayName,
        });
        // head, m2 (m1 and leaver were deleted and left).
        assert.equal(group.memberCount, 2);
        assert.equal(group.albumCount, 1);
        assert.equal(group.photoCount, 3);
        assert.equal(typeof group.usedBytes, 'number');
        assert.ok(group.usedBytes >= 3 * 2048);
        assert.equal(
          (
            await get('/v1/admin/groups?status=DELETING&limit=50').expect(200)
          ).body.items.filter((item: { id: string }) => item.id === groupId)
            .length,
          0
        );
        await get('/v1/admin/groups?status=CLOSED').expect(400);
        assert.equal(
          (await get(`/v1/admin/groups?cursor=${randomUUID()}`).expect(400))
            .body.code,
          'ADMIN_GROUP_CURSOR_INVALID'
        );
        const detail = await get(`/v1/admin/groups/${groupId}`).expect(200);
        assert.equal(detail.body.members.length, 5);
        // Withdrawn accounts are excluded from the member roster and count.
        const roster = (
          await head.agent
            .get(`/v1/groups/${groupId}/members?limit=50`)
            .expect(200)
        ).body.members.map((item: { userId: string }) => item.userId);
        assert.deepEqual(roster.sort(), [head.id, m2.id].sort());
        assert.equal(
          (await head.agent.get(`/v1/groups/${groupId}`).expect(200)).body.group
            .members,
          2
        );
        assert.deepEqual(detail.body.members[0].user, {
          id: head.id,
          displayName: head.displayName,
          status: 'ACTIVE',
        });
        assert.equal(detail.body.members[0].role, 'OWNER');
        assert.ok(
          detail.body.members.some(
            (member: {
              user: { id: string; status: string };
              status: string;
            }) =>
              member.user.id === leaver.id &&
              member.user.status === 'DELETED' &&
              member.status === 'LEFT'
          )
        );
        assert.deepEqual(
          detail.body.albums.map((a: { id: string; photoCount: number }) => [
            a.id,
            a.photoCount,
          ]),
          [[albumId, 3]]
        );
        assert.equal((await audits('ADMIN_GROUP_VIEWED', groupId)).length, 1);
        assert.equal(
          (await get(`/v1/admin/groups/${randomUUID()}`).expect(404)).body.code,
          'ADMIN_GROUP_NOT_FOUND'
        );
        const photos: string[] = [];
        let cursor: string | null = null;
        do {
          const page: Response = await get(
            `/v1/admin/groups/${groupId}/albums/${albumId}/photos?limit=2${cursor ? `&cursor=${cursor}` : ''}`
          ).expect(200);
          for (const item of page.body.items) {
            assert.deepEqual(Object.keys(item).sort(), [
              'bytes',
              'createdAt',
              'effectiveDate',
              'height',
              'id',
              'status',
              'uploader',
              'width',
            ]);
            assert.match(item.effectiveDate, /^\d{4}-\d{2}-\d{2}$/);
            photos.push(item.id);
          }
          cursor = page.body.nextCursor;
        } while (cursor);
        assert.ok(
          [m2Photo, leaverPhoto, m1Photo].every((id) => photos.includes(id))
        );
        assert.equal(new Set(photos).size, photos.length);
        assert.equal(
          (
            await get(
              `/v1/admin/groups/${leaverGroup}/albums/${albumId}/photos`
            ).expect(404)
          ).body.code,
          'ADMIN_ALBUM_NOT_FOUND'
        );
        assert.equal(
          (
            await get(
              `/v1/admin/groups/${groupId}/albums/${albumId}/photos?cursor=${randomUUID()}`
            ).expect(400)
          ).body.code,
          'ADMIN_PHOTO_CURSOR_INVALID'
        );
        await get(
          `/v1/admin/groups/${groupId}/albums/${albumId}/photos?limit=61`
        ).expect(400);
      }
    );

    await t.test(
      'metrics dashboard returns bounded aggregate counts only',
      async () => {
        const failedPhoto = randomUUID();
        await owner.query(
          `INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,"processingQueuedAt","processingErrorCode") VALUES($1,$2,$3,$4,'FAILED',now(),'PHOTO_PROCESSING_FAILED')`,
          [failedPhoto, groupId, albumId, head.id]
        );
        const before = (await get('/v1/admin/metrics').expect(200)).body;
        await owner.query(
          `INSERT INTO woori.photos(id,"groupId","albumId","uploaderId",status,"processingQueuedAt","processingErrorCode") VALUES($1,$2,$3,$4,'FAILED',now(),'PHOTO_PROCESSING_FAILED')`,
          [randomUUID(), groupId, albumId, head.id]
        );
        const metrics = await get('/v1/admin/metrics').expect(200);
        assert.equal(
          metrics.body.photoProcessing.failed24h,
          before.photoProcessing.failed24h + 1
        );
        assert.deepEqual(Object.keys(metrics.body).sort(), [
          'generatedAt',
          'groups',
          'inquiries',
          'mail',
          'mediaCleanup',
          'outbox',
          'photoProcessing',
          'push',
          'reports',
          'storage',
          'users',
        ]);
        assert.equal(metrics.body.mail, null);
        assert.deepEqual(Object.keys(metrics.body.users).sort(), [
          'active',
          'deleted',
          'suspended',
        ]);
        assert.ok(metrics.body.users.suspended >= 1);
        assert.ok(metrics.body.users.deleted >= 2);
        assert.deepEqual(Object.keys(metrics.body.photoProcessing).sort(), [
          'failed24h',
          'processing',
          'queued',
        ]);
        assert.deepEqual(Object.keys(metrics.body.push).sort(), [
          'failed24h',
          'pendingDeliveries',
        ]);
        assert.ok(metrics.body.reports.open >= 1);
        assert.equal(typeof metrics.body.storage.usedBytes, 'number');
        assert.ok(
          metrics.body.storage.quotaBytes >= metrics.body.storage.usedBytes
        );
        assert.ok(!Number.isNaN(Date.parse(metrics.body.generatedAt)));
      }
    );

    await t.test('audit rows hold listed metadata keys only', async () => {
      const rows = await query(
        'SELECT metadata FROM woori.admin_audit_logs WHERE "adminId"=$1',
        [admin.id]
      );
      const allowed = new Set<string>(ADMIN_AUDIT_METADATA_KEYS);
      for (const row of rows)
        for (const key of Object.keys(row.metadata))
          assert.ok(allowed.has(key), key);
      const dump = JSON.stringify(rows);
      for (const value of [
        password,
        newPassword,
        token,
        '@',
        `정리된 이름`,
        '첫째 문의',
      ])
        assert.ok(!dump.includes(value), value);
    });
  } finally {
    // Later suites in this disposable database (the media cleanup worker and web
    // push suites) assert on every cleanup job and delivery, so this suite's
    // fixture-created rows are removed.
    await owner
      .query(
        'DELETE FROM woori.media_cleanup_jobs j USING woori.photos p, woori.albums a WHERE p.id=j."photoId" AND a.id=p."albumId" AND a.title=$1 AND p."createdAt">now()-interval \'1 day\' AND p."groupId" IN (SELECT id FROM woori.groups WHERE name LIKE $2)',
        ['운영 앨범', `%${suffix}%`]
      )
      .catch(() => undefined);
    await owner
      .query(
        'DELETE FROM woori.notification_deliveries WHERE "deliveryKey" LIKE \'admin-fixture:%\''
      )
      .catch(() => undefined);
    await app.close();
    await owner.end();
  }
});
