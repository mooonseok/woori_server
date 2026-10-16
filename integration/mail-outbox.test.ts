import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { AdminMetricsRepository } from '../src/admin/admin-metrics.repository';
import { AuthRepository } from '../src/domain/auth/auth.repository';
import { rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import {
  MailDeliveryError,
  MailService,
  type MailDeliveryOptions,
} from '../src/domain/auth/mail.service';
import {
  enqueueMail,
  MailOutboxRepository,
  MailOutboxService,
} from '../src/domain/mail/mail-outbox';
import { WorkerHeartbeatRepository } from '../src/worker/heartbeat/worker-heartbeat.repository';

// Mutations are permitted only in the disposable database created by the
// existing local integration runner. Never accept the development DB itself.
function isolated(key: string) {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.equal(process.env.MAIL_MODE, 'file');
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  assert.notEqual(process.env.NODE_ENV, 'production');
  return url.toString();
}
type Mail = { to: string; subject: string; text: string; file: string };
type Row = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  payload: string | null;
  resultCode: string | null;
  sentAt: Date | null;
  emailTokenId: string | null;
  nextAttemptAt: Date;
  createdAt: Date;
};

test('isolated PostgreSQL: W07-4 mail outbox, retries and operations metrics', async (t) => {
  isolated('DATABASE_URL');
  const admin = new Pool({
    connectionString: isolated('MIGRATION_DATABASE_URL'),
    max: 2,
  });
  const app = await createApp();
  const mutate = (op: Test) =>
    op.set('Origin', process.env.WEB_ORIGIN!).set('X-Woori-Request', '1');
  const suffix = randomBytes(4).toString('hex');
  const password = 'mail-outbox-integration-password-2026';
  try {
    await app.listen(0, '127.0.0.1');
    const prisma = app.get(PrismaService).client;
    const outbox = app.get(MailOutboxService);
    const mailService = app.get(MailService);
    const mails = async (to: string) => {
      const found: Mail[] = [];
      for (const file of await readdir(process.env.DEV_MAIL_DIR!)) {
        if (!file.endsWith('.json')) continue;
        const value = JSON.parse(
          await readFile(join(process.env.DEV_MAIL_DIR!, file), 'utf8')
        );
        if (value.to === to) found.push({ ...value, file });
      }
      return found;
    };
    const tokenIn = (mail: Mail) =>
      new URL(mail.text.match(/https?:\/\/[^\s]+/)![0]).searchParams.get(
        'token'
      )!;
    const rows = async (userId: string) =>
      (
        await admin.query(
          'SELECT id,kind::text AS kind,status::text AS status,attempts,payload,"resultCode","sentAt","emailTokenId","nextAttemptAt","createdAt" FROM woori.mail_outbox WHERE "userId"=$1 ORDER BY "createdAt",id',
          [userId]
        )
      ).rows as Row[];
    const due = (id: string) =>
      admin.query(
        'UPDATE woori.mail_outbox SET "nextAttemptAt"=$2 WHERE id=$1',
        [id, new Date(Date.now() - 1000)]
      );
    // Only the signup test uses the signup API: the per-IP signup quota is
    // shared by every suite. Fixture members get a session and no verified
    // address; their mails are requested through the real endpoints.
    const signup = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const account = {
        username: `${label}_${suffix}`,
        email: `${label}_${suffix}@example.test`,
        displayName: label,
        password,
      };
      const response = await mutate(agent.post('/v1/auth/signup'))
        .send(account)
        .expect(201);
      // Give the shared per-IP signup budget back to the later suites.
      await admin.query(
        'UPDATE woori.rate_limit_buckets SET attempts=attempts-1 WHERE id=ANY($1) AND attempts>0',
        [
          ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
            (ip) =>
              rateLimitKey('auth', `signup-ip:${ip}`, new Date(), 60 * 60_000)
                .id
          ),
        ]
      );
      return { agent, account, id: response.body.user.id as string, response };
    };
    const passwordHash = await hashPassword(password);
    const member = async (label: string) => {
      const agent = request.agent(app.getHttpServer());
      const account = {
        username: `${label}_${suffix}`,
        email: `${label}_${suffix}@example.test`,
        displayName: label,
      };
      const token = createToken();
      const user = await app
        .get(AuthRepository)
        .createUser({ ...account, passwordHash }, hashToken(token));
      agent.set('Cookie', `woori_session=${token}`);
      return { agent, account, id: user.id };
    };
    const requestVerification = (who: {
      agent: ReturnType<typeof request.agent>;
    }) =>
      mutate(who.agent.post('/v1/auth/email-verification/request'))
        .send({})
        .expect(202);

    await t.test(
      'runtime grants: delivery state only, and a finished mail cannot keep its payload',
      async () => {
        const runtime = new Pool({
          connectionString: isolated('DATABASE_URL'),
          max: 1,
        });
        try {
          const privileges = (
            await runtime.query(
              `SELECT has_table_privilege(current_user,'woori.mail_outbox','UPDATE') AS "tableUpdate",
                has_column_privilege(current_user,'woori.mail_outbox','payload','UPDATE') AS payload,
                has_column_privilege(current_user,'woori.mail_outbox','status','UPDATE') AS status,
                has_column_privilege(current_user,'woori.mail_outbox','kind','UPDATE') AS kind,
                has_column_privilege(current_user,'woori.mail_outbox','userId','UPDATE') AS "user",
                has_column_privilege(current_user,'woori.mail_outbox','emailTokenId','UPDATE') AS token,
                has_column_privilege(current_user,'woori.mail_outbox','expiresAt','UPDATE') AS expiry,
                has_table_privilege(current_user,'woori.mail_outbox','DELETE') AS "delete",
                has_table_privilege(current_user,'woori.mail_outbox','TRUNCATE') AS "truncate",
                has_table_privilege(current_user,'woori.worker_heartbeats','INSERT') AS "beatInsert",
                has_table_privilege(current_user,'woori.worker_heartbeats','UPDATE') AS "beatUpdate",
                has_column_privilege(current_user,'woori.groups','deletionRequestedAt','UPDATE') AS "groupDeletion"`
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            tableUpdate: false,
            payload: true,
            status: true,
            kind: false,
            user: false,
            token: false,
            expiry: false,
            delete: true,
            truncate: false,
            beatInsert: true,
            beatUpdate: true,
            groupDeletion: true,
          });
          await assert.rejects(
            runtime.query(
              `UPDATE woori.mail_outbox SET "expiresAt"=now() WHERE false`
            ),
            (error: { code?: string }) => error.code === '42501'
          );
        } finally {
          await runtime.end();
        }
        const user = await member('mail_grants');
        await prisma.$transaction((tx) =>
          enqueueMail(tx, {
            id: randomUUID(),
            kind: 'RECOVER_USERNAME',
            userId: user.id,
            payload: { to: user.account.email, username: 'x' },
            expiresAt: new Date(Date.now() + 60_000),
          })
        );
        const [row] = await rows(user.id);
        await assert.rejects(
          admin.query(
            "UPDATE woori.mail_outbox SET status='DONE',payload='v1.a.b.c' WHERE id=$1",
            [row.id]
          ),
          (error: { code?: string }) => error.code === '23514'
        );
      }
    );

    await t.test(
      'signup queues the verification mail with its token and sends it at once',
      async () => {
        const user = await signup('mail_signup');
        assert.equal(user.response.body.verificationDelivery, 'sent');
        const [row] = await rows(user.id);
        assert.equal(row.kind, 'VERIFY_EMAIL');
        assert.equal(row.status, 'DONE');
        assert.equal(row.payload, null, 'Payload wiped after sending');
        assert.ok(row.sentAt);
        assert.equal(row.resultCode, 'sent');
        const [mail] = await mails(user.account.email);
        assert.equal(mail.file, `${row.createdAt.getTime()}-${row.id}.json`);
        const token = (
          await admin.query(
            'SELECT "tokenHash",purpose FROM woori.email_tokens WHERE id=$1',
            [row.emailTokenId]
          )
        ).rows[0];
        assert.equal(token.purpose, 'VERIFY_EMAIL');
        assert.equal(token.tokenHash, hashToken(tokenIn(mail)));
      }
    );

    await t.test(
      'a rolled-back transaction leaves neither a token nor a mail',
      async () => {
        const user = await member('mail_rollback');
        const before = (await rows(user.id)).length;
        const id = randomUUID();
        await assert.rejects(
          prisma.$transaction(async (tx) => {
            await enqueueMail(tx, {
              id,
              kind: 'RECOVER_USERNAME',
              userId: user.id,
              payload: { to: user.account.email, username: 'x' },
              expiresAt: new Date(Date.now() + 60_000),
            });
            throw new Error('intentional-rollback');
          }),
          /intentional-rollback/
        );
        assert.equal(
          (
            await admin.query('SELECT 1 FROM woori.mail_outbox WHERE id=$1', [
              id,
            ])
          ).rowCount,
          0
        );
        // A rejected email change (address in use) issues no token and no mail.
        const other = await member('mail_taken');
        await mutate(user.agent.post('/v1/auth/email-change/request'))
          .send({ currentPassword: password, newEmail: other.account.email })
          .expect(409);
        assert.equal((await rows(user.id)).length, before);
        assert.equal(
          (
            await admin.query(
              'SELECT 1 FROM woori.email_tokens WHERE "userId"=$1 AND purpose=\'CHANGE_EMAIL\'',
              [user.id]
            )
          ).rowCount,
          0
        );
      }
    );

    await t.test(
      'provider failures retry with backoff and one idempotency key until sent',
      async () => {
        const user = await member('mail_retry');
        const seen: MailDeliveryOptions[] = [];
        let failures = 2;
        const original = mailService.sendPasswordReset;
        // Only this member's mail is affected (other queued mail passes).
        mailService.sendPasswordReset = async (to, token, options = {}) => {
          if (to === user.account.email) {
            seen.push(options);
            if (failures-- > 0)
              throw new MailDeliveryError(true, 'provider-503');
          }
          return original.call(mailService, to, token, options);
        };
        try {
          await mutate(
            request(app.getHttpServer()).post('/v1/auth/recovery/password')
          )
            .send({ name: user.account.displayName, email: user.account.email })
            .expect(202);
          let row = (await rows(user.id)).find(
            (r) => r.kind === 'RESET_PASSWORD'
          )!;
          assert.equal(row.status, 'PENDING');
          assert.equal(row.attempts, 1);
          assert.equal(row.resultCode, 'provider-503');
          assert.ok(row.nextAttemptAt.getTime() - Date.now() > 20_000);
          // The queued payload is sealed: neither the address nor a token shows.
          assert.ok(row.payload);
          assert.ok(!row.payload.includes(user.account.email));
          assert.ok(!row.payload.includes('@'));
          // Not due yet: the worker leaves it alone.
          await outbox.runBatch();
          assert.equal(
            (await rows(user.id)).find((r) => r.id === row.id)!.attempts,
            1
          );
          await due(row.id);
          await outbox.runBatch();
          row = (await rows(user.id)).find((r) => r.id === row.id)!;
          assert.equal(row.attempts, 2);
          assert.equal(row.status, 'PENDING');
          assert.ok(row.nextAttemptAt.getTime() - Date.now() > 50_000);
          await due(row.id);
          await outbox.runBatch();
          row = (await rows(user.id)).find((r) => r.id === row.id)!;
          assert.equal(row.status, 'DONE');
          assert.equal(row.payload, null);
          assert.equal(seen.length, 3);
          assert.equal(new Set(seen.map((o) => o.idempotencyKey)).size, 1);
          assert.equal(seen[0].idempotencyKey, `woori-mail-${row.id}`);
          assert.equal(new Set(seen.map((o) => o.fileName)).size, 1);
          assert.equal(
            (await mails(user.account.email)).filter((m) =>
              m.subject.includes('비밀번호')
            ).length,
            1
          );
        } finally {
          mailService.sendPasswordReset = original;
        }
      }
    );

    await t.test(
      'a delivery whose commit was lost is re-claimed without a second mail',
      async () => {
        const user = await member('mail_lost');
        const repository = app.get(MailOutboxRepository);
        const original = repository.finish;
        repository.finish = async () => {
          throw new Error('lost commit response');
        };
        try {
          await requestVerification(user);
        } finally {
          repository.finish = original;
        }
        const row = (await rows(user.id)).at(-1)!;
        assert.equal(row.status, 'RUNNING');
        assert.equal((await mails(user.account.email)).length, 1);
        await admin.query(
          'UPDATE woori.mail_outbox SET "leaseUntil"=now()-interval \'1 second\' WHERE id=$1',
          [row.id]
        );
        await outbox.runBatch();
        const done = (await rows(user.id)).at(-1)!;
        assert.equal(done.status, 'DONE');
        assert.equal(done.attempts, 2);
        assert.equal(done.payload, null);
        assert.equal(
          (await mails(user.account.email)).length,
          1,
          'The same mail is not delivered twice'
        );
      }
    );

    await t.test(
      'expired, superseded and withdrawn mails are never sent and keep nothing',
      async () => {
        const user = await member('mail_supersede');
        const original = mailService.sendVerification;
        const failing = async () => {
          throw new MailDeliveryError(true, 'provider-503');
        };
        mailService.sendVerification = failing;
        try {
          await requestVerification(user);
        } finally {
          mailService.sendVerification = original;
        }
        const stale = (await rows(user.id)).at(-1)!;
        assert.equal(stale.status, 'PENDING');
        // A newer request replaces the token: the older mail is superseded.
        await requestVerification(user);
        await due(stale.id);
        await outbox.runBatch();
        const after = await rows(user.id);
        const closed = after.find((r) => r.id === stale.id)!;
        assert.equal(closed.status, 'FAILED');
        assert.equal(closed.resultCode, 'superseded');
        assert.equal(closed.payload, null);
        const sent = await mails(user.account.email);
        assert.ok(!sent.some((m) => m.file.endsWith(`-${stale.id}.json`)));
        // Expired before it could be sent.
        const expiring = await member('mail_expire');
        mailService.sendVerification = failing;
        try {
          await requestVerification(expiring);
        } finally {
          mailService.sendVerification = original;
        }
        const [late] = await rows(expiring.id);
        assert.equal(late.status, 'PENDING');
        await admin.query(
          'UPDATE woori.mail_outbox SET "expiresAt"=$2,"nextAttemptAt"=$2 WHERE id=$1',
          [late.id, new Date(Date.now() - 1000)]
        );
        await outbox.runBatch();
        const expired = (await rows(expiring.id))[0];
        assert.equal(expired.status, 'FAILED');
        assert.equal(expired.resultCode, 'expired');
        assert.equal(expired.payload, null);
        assert.deepEqual(await mails(expiring.account.email), []);
        // Account withdrawal erases queued mail (recipient and token) as well.
        const leaving = await member('mail_leave');
        mailService.sendVerification = failing;
        try {
          await requestVerification(leaving);
        } finally {
          mailService.sendVerification = original;
        }
        assert.equal((await rows(leaving.id))[0].status, 'PENDING');
        await mutate(leaving.agent.post('/v1/auth/account-deletion'))
          .send({ currentPassword: password, confirmation: '탈퇴' })
          .expect(204);
        assert.deepEqual(await rows(leaving.id), []);
      }
    );

    await t.test(
      'email change queues the confirmation link and the old-address notice',
      async () => {
        const user = await member('mail_change');
        const target = `mail_changed_${suffix}@example.test`;
        await mutate(user.agent.post('/v1/auth/email-change/request'))
          .send({ currentPassword: password, newEmail: target })
          .expect(202, { accepted: true });
        const [link] = await mails(target);
        await mutate(user.agent.post('/v1/auth/email-change/confirm'))
          .send({ token: tokenIn(link) })
          .expect(204);
        const kinds = (await rows(user.id)).map((r) => [r.kind, r.status]);
        assert.deepEqual(kinds, [
          ['CHANGE_EMAIL', 'DONE'],
          ['EMAIL_CHANGED_NOTICE', 'DONE'],
        ]);
        assert.ok(
          (await mails(user.account.email)).some((m) =>
            m.subject.includes('변경되었어요')
          )
        );
      }
    );

    await t.test(
      'admin metrics report mail counts, queue lag and the worker heartbeat',
      async () => {
        const metrics = app.get(AdminMetricsRepository);
        const before = await metrics.snapshot();
        const user = await member('mail_metrics');
        await requestVerification(user);
        const pending = randomUUID();
        await prisma.$transaction((tx) =>
          enqueueMail(tx, {
            id: pending,
            kind: 'RECOVER_USERNAME',
            userId: user.id,
            payload: { to: user.account.email, username: 'x' },
            expiresAt: new Date(Date.now() + 30 * 60_000),
          })
        );
        await admin.query(
          'UPDATE woori.mail_outbox SET "nextAttemptAt"=$2 WHERE id=$1',
          [pending, new Date(Date.now() - 5 * 60_000)]
        );
        const heartbeat = new WorkerHeartbeatRepository(app.get(PrismaService));
        const instance = `test-${suffix}`;
        await heartbeat.beat(instance, new Date(), true, true);
        const after = await metrics.snapshot();
        assert.equal(after.mail.sent24h, before.mail.sent24h + 1);
        assert.equal(after.mail.pending, before.mail.pending + 1);
        assert.ok(after.queues.mailOutbox.due >= 1);
        assert.ok(after.queues.mailOutbox.oldestDueSeconds! >= 299);
        assert.equal(after.workers.healthy, true);
        const beat = after.workers.instances.find(
          (w) => w.instanceId === instance
        );
        assert.ok(beat && beat.beatAgeSeconds <= 5 && beat.videoReady);
        assert.equal(beat.busyJob, null);
        assert.equal(beat.busySeconds, null);
        // A long transcode: the beat stays fresh and shows the job's age on the
        // DB clock (the worker's elapsed time is subtracted from now()).
        await heartbeat.beat(instance, new Date(), true, true, {
          job: 'video-transcode',
          since: new Date(Date.now() - 90_000),
        });
        const busy = (await metrics.snapshot()).workers.instances.find(
          (w) => w.instanceId === instance
        )!;
        assert.equal(busy.busyJob, 'video-transcode');
        assert.ok(busy.busySeconds! >= 89 && busy.busySeconds! <= 95);
        await heartbeat.beat(instance, new Date(), true, true, null);
        assert.equal(
          (await metrics.snapshot()).workers.instances.find(
            (w) => w.instanceId === instance
          )!.busyJob,
          null
        );
        await admin.query(
          'UPDATE woori.worker_heartbeats SET "beatAt"=now()-interval \'10 minutes\' WHERE "instanceId"=$1',
          [instance]
        );
        const stale = await metrics.snapshot();
        assert.ok(
          stale.workers.instances.find((w) => w.instanceId === instance)!
            .beatAgeSeconds >= 600
        );
        // Leave nothing due behind for later suites.
        await admin.query(
          "UPDATE woori.mail_outbox SET status='FAILED',payload=NULL,\"resultCode\"='fixture-cleanup' WHERE id=$1",
          [pending]
        );
        await admin.query(
          'DELETE FROM woori.worker_heartbeats WHERE "instanceId"=$1',
          [instance]
        );
      }
    );
  } finally {
    await app.close();
    await admin.end();
  }
});
