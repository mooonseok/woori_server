import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { likeLiteral, maskEmail } from '../src/admin/admin-users.repository';
import {
  AdminAlbumPhotoListDto,
  AdminGroupListDto,
  AdminUserListDto,
  AdminUserReasonDto,
  DeleteAdminUserDto,
  RenameAdminUserDto,
} from '../src/admin/dto/admin-members.dto';
import { unsuspendMember } from '../src/admin/member-suspension';

const errors = async (cls: new () => object, plain: object) =>
  (
    await validate(plainToInstance(cls, plain), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).length;

test('email masking keeps two local characters and hides deleted accounts', () => {
  assert.equal(
    maskEmail('family.one@example.test', 'ACTIVE'),
    'fa***@example.test'
  );
  assert.equal(maskEmail('a@x.io', 'SUSPENDED'), 'a***@x.io');
  assert.equal(
    maskEmail('가나다@example.test', 'ACTIVE'),
    '가나***@example.test'
  );
  assert.equal(maskEmail('x@deleted.invalid', 'DELETED'), null);
  assert.equal(maskEmail('not-an-email', 'ACTIVE'), null);
});

test('search text is matched literally in LIKE patterns', () => {
  assert.equal(likeLiteral('100%_done\\'), '100\\%\\_done\\\\');
  assert.equal(likeLiteral('가족'), '가족');
});

test('admin member DTOs: query bounds, reasons 5..500, normalized confirmation', async () => {
  const list = plainToInstance(AdminUserListDto, { query: '  가족 ' });
  assert.equal((await validate(list)).length, 0);
  assert.equal(list.query, '가족');
  assert.equal(list.limit, 20);
  for (const plain of [
    { query: 'x'.repeat(65) },
    { query: '줄\n바꿈' },
    { status: 'BANNED' },
    { limit: 51 },
  ])
    assert.ok(
      (await errors(AdminUserListDto, plain)) > 0,
      JSON.stringify(plain)
    );
  assert.equal(await errors(AdminUserReasonDto, { reason: '정지 사유' }), 0);
  for (const reason of ['짧은', 'x'.repeat(501), '사유‮확인'])
    assert.ok((await errors(AdminUserReasonDto, { reason })) > 0, reason);
  assert.ok(
    (await errors(RenameAdminUserDto, {
      displayName: '',
      reason: '이름 정리 사유',
    })) > 0
  );
  assert.ok(
    (await errors(RenameAdminUserDto, {
      displayName: 'x'.repeat(81),
      reason: '이름 정리 사유',
    })) > 0
  );
  const remove = plainToInstance(DeleteAdminUserDto, {
    reason: '본인 요청 삭제',
    confirmUsername: '  Family_One ',
  });
  assert.equal((await validate(remove)).length, 0);
  assert.equal(remove.confirmUsername, 'family_one');
  assert.ok(
    (await errors(DeleteAdminUserDto, { reason: '본인 요청 삭제' })) > 0
  );
  assert.ok((await errors(AdminGroupListDto, { status: 'CLOSED' })) > 0);
  const photos = plainToInstance(AdminAlbumPhotoListDto, {});
  assert.equal((await validate(photos)).length, 0);
  assert.equal(photos.limit, 30);
  assert.equal(await errors(AdminAlbumPhotoListDto, { limit: '60' }), 0);
  assert.ok((await errors(AdminAlbumPhotoListDto, { limit: '61' })) > 0);
});

test('unsuspension applies only to suspended accounts and restores ACTIVE only', async () => {
  const updates: string[] = [];
  const fakeTx = (status: string | undefined) =>
    ({
      $queryRaw: async () => (status ? [{ status }] : []),
      user: {
        update: async (args: { data: { status: string } }) => {
          updates.push(args.data.status);
        },
      },
    }) as unknown as Prisma.TransactionClient;
  for (const status of ['ACTIVE', 'DELETED', undefined])
    await assert.rejects(
      unsuspendMember(fakeTx(status), randomUUID()),
      (error: { response?: { code?: string } }) =>
        error.response?.code === 'ADMIN_USER_NOT_SUSPENDED'
    );
  assert.deepEqual(updates, []);
  await unsuspendMember(fakeTx('SUSPENDED'), randomUUID());
  assert.deepEqual(updates, ['ACTIVE']);
});
