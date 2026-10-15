import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { adminAuditMetadata } from '../src/admin/admin-audit';
import { publishAtError } from '../src/admin/admin-content-policy';
import {
  AdminReportListDto,
  AdminViewReasonDto,
  CreateAdminNoticeDto,
  PublishAdminNoticeDto,
  ResolveReportDto,
  UpdateAdminNoticeDto,
} from '../src/admin/dto/admin-content.dto';
import { suspendMember } from '../src/admin/member-suspension';

const errors = async (cls: new () => object, plain: object) =>
  (
    await validate(plainToInstance(cls, plain), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).length;

test('notice publication window is [now − 1 min, now + 90 days]', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);
  const day = 24 * 60 * 60_000;
  assert.equal(publishAtError(now, now), false);
  assert.equal(publishAtError(at(-60_000), now), false);
  assert.equal(publishAtError(at(-60_001), now), true);
  assert.equal(publishAtError(at(90 * day), now), false);
  assert.equal(publishAtError(at(90 * day + 1), now), true);
  assert.equal(publishAtError(new Date('invalid'), now), true);
});

test('admin content DTOs trim plain text, reject control/bidi characters and require explicit offsets', async () => {
  const notice = plainToInstance(CreateAdminNoticeDto, {
    title: '  공지  ',
    body: ' 첫 줄\n\t둘째 줄 ',
  });
  assert.equal((await validate(notice)).length, 0);
  assert.equal(notice.title, '공지');
  assert.equal(notice.body, '첫 줄\n\t둘째 줄');
  for (const plain of [
    { title: 'x'.repeat(121), body: '본문' },
    { title: '줄\n바꿈', body: '본문' },
    { title: '제목‮', body: '본문' },
    { title: '제목', body: 'x'.repeat(10_001) },
    { title: '제목', body: '\u0000' },
    { title: '제목' },
  ])
    assert.ok(
      (await errors(CreateAdminNoticeDto, plain)) > 0,
      JSON.stringify(plain)
    );
  assert.equal(await errors(UpdateAdminNoticeDto, {}), 0);
  assert.equal(await errors(UpdateAdminNoticeDto, { body: '본문만' }), 0);
  assert.ok((await errors(UpdateAdminNoticeDto, { title: ' ' })) > 0);
  assert.ok((await errors(UpdateAdminNoticeDto, { title: null })) > 0);
  assert.equal(
    await errors(PublishAdminNoticeDto, {
      publishAt: '2026-10-16T09:00:00+09:00',
    }),
    0
  );
  assert.equal(await errors(PublishAdminNoticeDto, {}), 0);
  for (const publishAt of ['2026-10-16T09:00:00', '2026-10-16', 'tomorrow'])
    assert.ok(
      (await errors(PublishAdminNoticeDto, { publishAt })) > 0,
      publishAt
    );
  assert.equal(
    await errors(ResolveReportDto, {
      action: 'DELETE_CONTENT',
      reason: '삭제',
    }),
    0
  );
  for (const plain of [
    { action: 'BAN', reason: '사유' },
    { action: 'SUSPEND_USER', reason: '' },
    { action: 'SUSPEND_USER', reason: 'x'.repeat(501) },
    { action: 'SUSPEND_USER', reason: '사유', notify: true },
  ])
    assert.ok(
      (await errors(ResolveReportDto, plain)) > 0,
      JSON.stringify(plain)
    );
  assert.equal(await errors(AdminViewReasonDto, { reason: '신고 확인' }), 0);
  for (const reason of ['짧은', '    abc   ', '사유\n줄바꿈'])
    assert.ok((await errors(AdminViewReasonDto, { reason })) > 0, reason);
  const list = plainToInstance(AdminReportListDto, {});
  assert.equal((await validate(list)).length, 0);
  assert.equal(list.status, 'OPEN');
  assert.equal(list.limit, 20);
  assert.ok((await errors(AdminReportListDto, { status: 'CLOSED' })) > 0);
});

test('audit metadata accepts UUIDs only for *Id keys', () => {
  const id = randomUUID();
  assert.deepEqual(
    adminAuditMetadata({
      photoId: id,
      groupId: id,
      action: 'DELETE_CONTENT',
      alsoResolved: 2,
    }),
    { photoId: id, groupId: id, action: 'DELETE_CONTENT', alsoResolved: 2 }
  );
  for (const metadata of [
    { photoId: 'not-a-uuid' },
    { reportId: 'DELETE_CONTENT' },
    { userId: 1 },
    { action: id },
  ])
    assert.throws(() => adminAuditMetadata(metadata as never));
});

test('member suspension is idempotent, refuses withdrawn accounts and revokes credentials', async () => {
  const calls: string[] = [];
  const fakeTx = (status: string | undefined) =>
    ({
      $queryRaw: async () => {
        calls.push('lock-user');
        return status ? [{ status }] : [];
      },
      user: {
        update: async (args: { data: { status: string } }) => {
          calls.push(`user:${args.data.status}`);
        },
      },
      emailToken: { updateMany: async () => calls.push('email-tokens') },
      session: { updateMany: async () => calls.push('sessions') },
      pushInstallation: { updateMany: async () => calls.push('push') },
    }) as unknown as Prisma.TransactionClient;
  for (const status of ['DELETED', undefined])
    await assert.rejects(
      suspendMember(fakeTx(status), randomUUID()),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'ADMIN_USER_NOT_SUSPENDABLE'
    );
  calls.length = 0;
  assert.deepEqual(await suspendMember(fakeTx('SUSPENDED'), randomUUID()), {
    changed: false,
    previousStatus: 'SUSPENDED',
  });
  assert.deepEqual(calls, ['lock-user']);
  calls.length = 0;
  assert.deepEqual(await suspendMember(fakeTx('ACTIVE'), randomUUID()), {
    changed: true,
    previousStatus: 'ACTIVE',
  });
  // The user row lock comes first, then the credential rows.
  assert.deepEqual(calls, [
    'lock-user',
    'user:SUSPENDED',
    'email-tokens',
    'sessions',
    'push',
  ]);
});
