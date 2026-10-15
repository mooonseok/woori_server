import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Prisma } from '@prisma/client';
import {
  CreateInquiryDto,
  ServiceSupportPageDto,
} from '../src/domain/service-support/dto/service-support.dto';
import { isInquiryText } from '../src/domain/service-support/inquiry-policy';
import {
  lockRateLimitKey,
  tooManyRequests,
} from '../src/domain/auth/auth-rate-limit.service';
const options = { whitelist: true, forbidNonWhitelisted: true };
const errors = async (value: Record<string, unknown>) =>
  validate(plainToInstance(CreateInquiryDto, value), options);

test('inquiry text is trimmed before validation and keeps inner line breaks', async () => {
  const dto = plainToInstance(CreateInquiryDto, {
    category: 'BUG',
    title: ' 　 사진이 안 보여요 \t',
    body: '\n  첫 줄\r\n\t둘째 줄  \n ',
  });
  assert.equal(dto.title, '사진이 안 보여요');
  assert.equal(dto.body, '첫 줄\r\n\t둘째 줄');
  assert.equal((await validate(dto, options)).length, 0);
});
test('inquiry title/body lengths count code points like PostgreSQL varchar', async () => {
  const valid = { category: 'OTHER', title: '제목', body: '본문' };
  for (const ok of [
    { title: 'a'.repeat(100) },
    { title: '😀'.repeat(100) },
    { body: '가'.repeat(2000) },
    // A variation selector is its own code point: 1000 x 2 = 2000.
    { body: '❤️'.repeat(1000) },
  ])
    assert.equal((await errors({ ...valid, ...ok })).length, 0);
  for (const bad of [
    { title: '' },
    { title: '   ' },
    { title: 'a'.repeat(101) },
    { title: '😀'.repeat(101) },
    { body: '\n\t \r\n' },
    { body: '가'.repeat(2001) },
    { body: '❤️'.repeat(1001) },
  ])
    assert.equal((await errors({ ...valid, ...bad })).length, 1, String(bad));
});
test('inquiry rejects control characters, unknown fields and bad categories', async () => {
  const valid = { category: 'ACCOUNT', title: '제목', body: '본문' };
  for (const bad of [
    { title: '첫 줄\n둘째 줄' },
    { title: '탭\t포함' },
    { title: 'nul\u0000' },
    { body: 'nul\u0000문자' },
    { body: 'bell\u0007' },
    { body: 'escape\u001b[31m' },
    { body: 'delete\u007f' },
    { body: 'c1\u0085next' },
    { body: 'lone \ud800 surrogate' },
    { category: 'SPAM' },
    { category: 'account' },
    { category: undefined },
    { title: 123 },
    { body: ['본문'] },
  ])
    assert.ok((await errors({ ...valid, ...bad })).length, JSON.stringify(bad));
  assert.ok((await errors({ ...valid, status: 'ANSWERED' })).length);
  assert.ok((await errors({ ...valid, userId: 'forged' })).length);
  assert.ok(isInquiryText('줄\r\n바꿈\t탭', 2000, true));
  assert.ok(!isInquiryText('줄\r\n바꿈', 100, false));
  assert.ok(!isInquiryText(null, 100, false));
});
test('service support pages bound limit and cursor', async () => {
  const defaults = plainToInstance(ServiceSupportPageDto, {});
  assert.equal(defaults.limit, 20);
  assert.equal((await validate(defaults, options)).length, 0);
  for (const ok of [
    { limit: '1' },
    { limit: '50' },
    { cursor: '315097d9-f1a4-4202-ad40-455124a80cc2' },
  ])
    assert.equal(
      (await validate(plainToInstance(ServiceSupportPageDto, ok), options))
        .length,
      0
    );
  for (const bad of [
    { limit: '0' },
    { limit: '51' },
    { limit: '1.5' },
    { limit: 'abc' },
    { cursor: '' },
    { cursor: 'not-a-uuid' },
    { status: 'DRAFT' },
  ])
    assert.ok(
      (await validate(plainToInstance(ServiceSupportPageDto, bad), options))
        .length,
      JSON.stringify(bad)
    );
});
test('count-based limits lock a hashed per-user key before counting', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      calls.push({ sql: strings.join('?'), values });
      return 1;
    },
  } as unknown as Prisma.TransactionClient;
  await lockRateLimitKey(tx, 'inquiry-create', 'user-1');
  await lockRateLimitKey(tx, 'report-create', 'user-1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /pg_advisory_xact_lock\(hashtextextended/);
  // Scopes never share a lock and the raw user id is never the lock key.
  assert.notEqual(calls[0].values[0], calls[1].values[0]);
  assert.doesNotMatch(String(calls[0].values[0]), /user-1/);
  assert.throws(
    () => tooManyRequests(),
    (error: any) =>
      error.getStatus() === 429 &&
      error.getResponse().code === 'TOO_MANY_REQUESTS'
  );
});
test('inquiry titles reject bidi controls and line separators; bodies reject bidi controls', async () => {
  const valid = { category: 'OTHER', title: '제목', body: '본문' };
  for (const bad of [
    { title: '방향\u202E바꿈' },
    { title: '격리\u2066시작' },
    { title: '줄\u2028구분' },
    { title: '문단\u2029구분' },
    { body: '방향\u202A포함' },
    { body: '격리\u2069끝' },
  ])
    assert.ok((await errors({ ...valid, ...bad })).length, JSON.stringify(bad));
  assert.equal(
    (await errors({ ...valid, body: '본문 줄\u2028구분 허용' })).length,
    0
  );
});
