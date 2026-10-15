import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  notBlockedBy,
  notBlockedBySql,
  notBlocking,
  visiblePhotoWhere,
} from '../src/domain/blocks/block-visibility';
import {
  BlockListDto,
  BlockParamsDto,
} from '../src/domain/blocks/dto/blocks.dto';
const options = { whitelist: true, forbidNonWhitelisted: true };
const id = '315097d9-f1a4-4202-ad40-455124a80cc2';

test('block visibility predicates share one viewer-only rule', () => {
  assert.deepEqual(notBlockedBy(id), {
    blockedBy: { none: { blockerId: id } },
  });
  assert.deepEqual(notBlocking(id), { blocks: { none: { blockedId: id } } });
  assert.deepEqual(visiblePhotoWhere(id), {
    status: 'READY',
    deletedAt: null,
    uploader: { blockedBy: { none: { blockerId: id } } },
  });
  const sql = notBlockedBySql(id, Prisma.sql`p."uploaderId"`);
  assert.match(sql.sql, /^NOT EXISTS \(SELECT 1 FROM woori\.user_blocks ub/);
  assert.match(sql.sql, /ub\."blockedId"=p\."uploaderId"/);
  // The viewer id is always a bound parameter, never interpolated text.
  assert.deepEqual(sql.values, [id]);
  assert.doesNotMatch(sql.sql, new RegExp(id));
});
test('block inputs validate the user id and page bounds', async () => {
  assert.equal(
    (await validate(plainToInstance(BlockParamsDto, { userId: id }), options))
      .length,
    0
  );
  assert.ok(
    (await validate(plainToInstance(BlockParamsDto, { userId: 'x' }), options))
      .length
  );
  assert.equal(plainToInstance(BlockListDto, {}).limit, 20);
  for (const ok of [{ limit: '1' }, { limit: '50' }, { cursor: id }])
    assert.equal(
      (await validate(plainToInstance(BlockListDto, ok), options)).length,
      0
    );
  for (const bad of [
    { limit: '0' },
    { limit: '51' },
    { cursor: 'x' },
    { blockerId: id },
  ])
    assert.ok(
      (await validate(plainToInstance(BlockListDto, bad), options)).length
    );
});
