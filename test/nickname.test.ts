import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SignupDto, UpdateProfileDto } from '../src/domain/auth/dto/auth.dto';

const account = {
  username: 'nickname_test',
  password: 'nickname-password-2026',
  displayName: '복구 이름',
  email: 'nickname@example.test',
};
test('nickname normalizes NFC and trims while preserving the private recovery name', async () => {
  const dto = plainToInstance(SignupDto, {
    ...account,
    nickname: '  가족 친구_1-2  ',
  });
  assert.equal((await validate(dto)).length, 0);
  assert.equal(dto.nickname, '가족 친구_1-2');
  assert.equal(dto.displayName, '복구 이름');
  assert.equal((await validate(plainToInstance(SignupDto, account))).length, 0);
  assert.equal(
    (
      await validate(
        plainToInstance(SignupDto, { ...account, nickname: '𐐀'.repeat(20) })
      )
    ).length,
    0
  );
});
test('nickname rejects invalid lengths, emoji, controls, null and invisible or bidi characters', async () => {
  for (const nickname of [
    '',
    '  ',
    '가',
    '가'.repeat(21),
    '𐐀'.repeat(21),
    '가족💗',
    '가\n족',
    '가\t족',
    '가\u200b족',
    '가\u202e족',
    '<가족>',
    null,
    123,
  ]) {
    assert.ok(
      (await validate(plainToInstance(SignupDto, { ...account, nickname })))
        .length,
      String(nickname)
    );
  }
});
test('profile accepts nickname or recovery name independently and rejects empty/null patches', async () => {
  for (const input of [
    { nickname: '새 별명' },
    { displayName: '새 이름' },
    { nickname: '새 별명', displayName: '새 이름' },
  ])
    assert.equal(
      (await validate(plainToInstance(UpdateProfileDto, input))).length,
      0
    );
  for (const input of [
    {},
    { nickname: null },
    { displayName: null },
    { nickname: null, displayName: '유효 이름' },
    { nickname: '가' },
    { nickname: '   ' },
  ])
    assert.ok(
      (await validate(plainToInstance(UpdateProfileDto, input))).length
    );
});
