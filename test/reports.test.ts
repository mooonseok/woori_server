import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateReportDto,
  ReportListDto,
} from '../src/domain/reports/dto/reports.dto';
import { normalizeReportDetail } from '../src/domain/reports/report-policy';
import { isPlainText } from '../src/common/decorators/plain-text.decorator';
const options = { whitelist: true, forbidNonWhitelisted: true };
const id = '315097d9-f1a4-4202-ad40-455124a80cc2';
const errors = async (value: Record<string, unknown>) =>
  validate(plainToInstance(CreateReportDto, value), options);

test('report detail is trimmed and blank detail becomes no detail', () => {
  assert.equal(
    normalizeReportDetail('  사진 설명\n둘째 줄 \t'),
    '사진 설명\n둘째 줄'
  );
  assert.equal(normalizeReportDetail(' \n\t　 '), null);
  assert.equal(normalizeReportDetail(''), null);
  assert.equal(normalizeReportDetail(null), null);
  assert.equal(normalizeReportDetail(undefined), undefined);
  assert.equal(normalizeReportDetail(5), 5);
  const dto = plainToInstance(CreateReportDto, {
    targetType: 'PHOTO',
    targetId: id,
    reason: 'OTHER',
    detail: '   ',
  });
  assert.equal(dto.detail, null);
});
test('report requests validate enums, group requirement, detail length and control characters', async () => {
  const photo = { targetType: 'PHOTO', targetId: id, reason: 'SPAM' };
  for (const ok of [
    photo,
    { ...photo, groupId: id },
    { ...photo, targetType: 'COMMENT' },
    { ...photo, targetType: 'USER', groupId: id },
    { ...photo, detail: '가'.repeat(500) },
    { ...photo, detail: '줄\r\n바꿈\t탭' },
    { ...photo, detail: null },
    { ...photo, detail: '  ' },
  ])
    assert.equal((await errors(ok)).length, 0, JSON.stringify(ok));
  for (const bad of [
    { ...photo, targetType: 'USER' },
    { ...photo, targetType: 'ALBUM' },
    { ...photo, targetType: 'photo' },
    { ...photo, reason: 'ABUSE' },
    { ...photo, reason: undefined },
    { ...photo, targetId: 'not-a-uuid' },
    { ...photo, groupId: null },
    { ...photo, groupId: 'bad' },
    { ...photo, detail: '가'.repeat(501) },
    { ...photo, detail: '널\u0000' },
    { ...photo, detail: '벨\u0007' },
    { ...photo, detail: 'c1\u009b' },
    { ...photo, detail: 42 },
    { ...photo, status: 'RESOLVED' },
    { ...photo, reporterId: id },
  ])
    assert.ok((await errors(bad)).length, JSON.stringify(bad));
  assert.ok(isPlainText('', 0, 10, false));
  assert.ok(!isPlainText('', 1, 10, false));
});
test('report list bounds limit and cursor', async () => {
  assert.equal(plainToInstance(ReportListDto, {}).limit, 20);
  for (const ok of [{ limit: '1' }, { limit: '50' }, { cursor: id }])
    assert.equal(
      (await validate(plainToInstance(ReportListDto, ok), options)).length,
      0
    );
  for (const bad of [
    { limit: '0' },
    { limit: '51' },
    { cursor: 'x' },
    { status: 'RECEIVED' },
  ])
    assert.ok(
      (await validate(plainToInstance(ReportListDto, bad), options)).length
    );
});
test('report detail rejects bidi controls but keeps multiline separators', async () => {
  const photo = { targetType: 'PHOTO', targetId: id, reason: 'OTHER' };
  for (const detail of ['방향\u202D덮어쓰기', '격리\u2068', '\u202C끝'])
    assert.ok((await errors({ ...photo, detail })).length, detail);
  assert.equal(
    (await errors({ ...photo, detail: '첫 줄\u2028둘째 줄' })).length,
    0
  );
});
