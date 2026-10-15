import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exifCapturedAt } from '../src/common/media/photo-capture-date';
import {
  assertLocalBackfillDatabase,
  PhotoDateBackfillService,
} from '../src/domain/photos/photo-date-backfill.service';
import { PhotoDateBackfillRepository } from '../src/domain/photos/photo-date-backfill.repository';
import { MediaStorageService } from '../src/common/media/media-storage.service';

const now = new Date('2026-10-15T12:00:00Z');
function fixture(date: string, offset?: string, endian = 'II', prefix = true) {
  const fields = [
    [0x9003, `${date}\0`],
    ...(offset === undefined ? [] : [[0x9011, `${offset}\0`]]),
  ] as [number, string][];
  const data = Buffer.alloc(256);
  data.write(endian);
  const u16 = (value: number, at: number) =>
    endian === 'II'
      ? data.writeUInt16LE(value, at)
      : data.writeUInt16BE(value, at);
  const u32 = (value: number, at: number) =>
    endian === 'II'
      ? data.writeUInt32LE(value, at)
      : data.writeUInt32BE(value, at);
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x8769, 10);
  u16(4, 12);
  u32(1, 14);
  u32(26, 18);
  u16(fields.length, 26);
  let content = 26 + 2 + fields.length * 12 + 4;
  fields.forEach(([tag, value], index) => {
    const at = 28 + index * 12;
    u16(tag, at);
    u16(2, at + 2);
    u32(value.length, at + 4);
    u32(content, at + 8);
    data.write(value, content, 'ascii');
    content += value.length;
  });
  return Buffer.concat([
    prefix ? Buffer.from('Exif\0\0') : Buffer.alloc(0),
    data.subarray(0, content),
  ]);
}
test('EXIF original date accepts both byte orders and explicit offsets; missing offset means KST', () => {
  for (const endian of ['II', 'MM'])
    for (const prefix of [true, false]) {
      assert.equal(
        exifCapturedAt(
          fixture('2020:02:29 00:30:00', undefined, endian, prefix),
          now
        )?.toISOString(),
        '2020-02-28T15:30:00.000Z'
      );
      assert.equal(
        exifCapturedAt(
          fixture('2020:02:29 00:30:00', '-08:00', endian, prefix),
          now
        )?.toISOString(),
        '2020-02-29T08:30:00.000Z'
      );
      assert.equal(
        exifCapturedAt(
          fixture('2020:02:29 00:30:00', '+14:00', endian, prefix),
          now
        )?.toISOString(),
        '2020-02-28T10:30:00.000Z'
      );
    }
});
test('invalid calendar, offset, old/future KST dates safely fall back', () => {
  for (const date of [
    '2021:02:29 12:00:00',
    '2020:04:31 12:00:00',
    '2020:00:01 12:00:00',
    '2020:01:00 12:00:00',
    '2020:01:01 24:00:00',
    '2020:01:01 12:60:00',
    '2020:01:01 12:00:60',
    '1799:12:31 23:59:59',
    '2099:01:01 00:00:00',
  ])
    assert.equal(exifCapturedAt(fixture(date), now), null, date);
  for (const offset of [
    '+14:01',
    '+15:00',
    '-12:60',
    ' 09:00',
    '+9:00',
    '      ',
  ])
    assert.equal(
      exifCapturedAt(fixture('2020:01:01 12:00:00', offset), now),
      null,
      offset
    );
  assert.equal(
    exifCapturedAt(fixture('2026:10:15 23:59:59'), now)?.toISOString(),
    '2026-10-15T14:59:59.000Z'
  );
  assert.equal(
    exifCapturedAt(fixture('2026:10:15 23:59:59', '-14:00'), now),
    null
  );
  assert.equal(
    exifCapturedAt(fixture('1800:01:01 00:00:00'), now)?.toISOString(),
    '1799-12-31T15:00:00.000Z'
  );
});
test('malformed and truncated EXIF never throw; offsets/counts/types/terminators are bounded', () => {
  const valid = fixture('2020:01:01 12:00:00', '+09:00');
  for (let end = 0; end < valid.length; end++)
    assert.equal(exifCapturedAt(valid.subarray(0, end), now), null);
  for (const [at, value, size] of [
    [10, 0xffffffff, 4],
    [14, 65535, 2],
    [24, 0xffffffff, 4],
    [32, 65535, 2],
    [36, 7, 2],
    [38, 0xffffffff, 4],
    [42, 0xffffffff, 4],
  ] as const) {
    const damaged = Buffer.from(valid);
    if (size === 2) damaged.writeUInt16LE(value, at);
    else damaged.writeUInt32LE(value, at);
    assert.equal(exifCapturedAt(damaged, now), null);
  }
  const unterminated = Buffer.from(valid);
  unterminated[unterminated.length - 1] = 65;
  assert.equal(exifCapturedAt(unterminated, now), null);
  assert.equal(exifCapturedAt(Buffer.alloc(1024 * 1024 + 1), now), null);
  assert.equal(exifCapturedAt(undefined, now), null);
});
test('backfill connection guard rejects remote, privileged, wrong database and query redirection', () => {
  for (const path of ['woori_dev', 'woori_test_123456abcdef'])
    assert.doesNotThrow(() =>
      assertLocalBackfillDatabase(
        `postgresql://woori_api:x@127.0.0.1:55439/${path}?schema=woori`
      )
    );
  for (const url of [
    'postgresql://woori_api:x@db.example:55439/woori_dev',
    'postgresql://postgres:x@127.0.0.1:55439/woori_dev',
    'postgresql://woori_api:x@127.0.0.1:5432/woori_dev',
    'postgresql://woori_api:x@127.0.0.1:55439/production',
    'postgresql://woori_api:x@127.0.0.1:55439/woori_dev?host=remote',
    'postgresql://woori_api:x@127.0.0.1:55439/woori_dev?hostaddr=remote',
    'http://woori_api:x@127.0.0.1:55439/woori_dev',
    'postgresql://woori_api:x@127.0.0.1:55439/woori_dev?user=postgres',
    'postgresql://woori_api:x@127.0.0.1:55439/woori_dev?port=5432',
  ])
    assert.throws(() => assertLocalBackfillDatabase(url));
});
test('backfill dry run never reads R2; apply is sequential and failed reads remain unchecked', async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL =
    'postgresql://woori_api:x@127.0.0.1:55439/woori_test_123456abcdef';
  const saved: string[] = [],
    read: string[] = [];
  let active = 0;
  const repository = {
    count: async () => 3,
    eligible: async () => true,
    candidates: async () =>
      ['dated', 'failed', 'deleted'].map((id) => ({
        id,
        groupId: 'group',
        albumId: 'album',
        objectKey: id,
        bytes: 100n,
      })),
    save: async (row: { id: string }) => {
      saved.push(row.id);
      return row.id !== 'deleted';
    },
  } as unknown as PhotoDateBackfillRepository;
  const storage = {
    enabled: () => true,
    captureDate: async (key: string) => {
      active++;
      assert.equal(active, 1);
      read.push(key);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (key === 'failed') throw new Error('read failure');
      return key === 'dated' ? new Date('2020-01-01T00:00:00Z') : null;
    },
  } as unknown as MediaStorageService;
  try {
    const service = new PhotoDateBackfillService(repository, storage);
    assert.equal((await service.run()).candidates, 3);
    assert.deepEqual(read, []);
    assert.deepEqual(saved, []);
    assert.deepEqual(await service.run({ apply: true }), {
      mode: 'apply',
      candidates: 3,
      scanned: 3,
      updated: 1,
      withDate: 1,
      skipped: 1,
      failed: 1,
      nextCursor: null,
    });
    assert.deepEqual(saved, ['dated', 'deleted']);
    for (const limit of [0, -1, 101, 1.5])
      await assert.rejects(service.run({ limit }));
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
