import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  MediaStorageService,
  collectBounded,
  MAX_UPLOAD_BYTES,
  MediaStorageOptions,
} from '../src/common/media/media-storage.service';

const options: MediaStorageOptions = {
  accountId: 'a'.repeat(32),
  accessKeyId: 'unit-test-access',
  secretAccessKey: 'unit-test-secret',
  bucket: 'unit-test-private',
};
class MemoryStorage extends MediaStorageService {
  input = Buffer.alloc(0);
  mime = 'image/jpeg';
  written = new Map<string, Buffer>();
  removed: string[] = [];
  failPut = 0;
  onPut?: () => void;
  constructor() {
    super(options);
  }
  protected override async download(_key: string, max: number) {
    return {
      data: await collectBounded(Readable.from([this.input]), max),
      contentType: this.mime,
    };
  }
  protected override async put(key: string, data: Buffer) {
    this.onPut?.();
    if (this.failPut === this.written.size + 1)
      throw new Error('controlled write failure');
    this.written.set(key, data);
  }
  override async cleanup(keys: string[]) {
    this.removed.push(...keys);
    keys.forEach((key) => this.written.delete(key));
  }
}
async function photo(format: 'jpeg' | 'png' | 'webp' = 'jpeg') {
  return sharp({
    create: { width: 80, height: 40, channels: 3, background: '#386aa5' },
  })
    .toFormat(format)
    .toBuffer();
}
const hasCode = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'getResponse' in error &&
  (error as { getResponse(): { code: string } }).getResponse().code === code;

test('missing R2 settings fail closed without affecting service construction', async () => {
  const storage = new MediaStorageService({});
  assert.equal(storage.enabled(), false);
  await assert.rejects(
    storage.presign('staging/photo-test', 'image/jpeg', 100),
    hasCode('MEDIA_STORAGE_NOT_CONFIGURED')
  );
  assert.equal(
    new MediaStorageService({
      ...options,
      accountId: 'attacker.invalid/path',
    }).enabled(),
    false
  );
});
test('PUT signing binds MIME and exact bytes without injecting an empty checksum', async () => {
  const storage = new MediaStorageService(options);
  const signed = await storage.presign(
    'staging/photo-test',
    'image/jpeg',
    1234
  );
  const url = new URL(signed.uploadUrl);
  assert.equal(url.hostname, `${options.accountId}.r2.cloudflarestorage.com`);
  assert.equal(url.pathname, '/unit-test-private/staging/photo-test');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /content-length/);
  assert.match(url.searchParams.get('X-Amz-SignedHeaders')!, /content-type/);
  assert.equal(
    [...url.searchParams.keys()].some((key) => /checksum/i.test(key)),
    false
  );
  assert.deepEqual(signed.headers, { 'Content-Type': 'image/jpeg' });
  for (const [key, mime, bytes] of [
    ['photos/test', 'image/jpeg', 100],
    ['staging/../escape', 'image/jpeg', 100],
    ['staging/test', 'image/svg+xml', 100],
    ['staging/test', 'image/jpeg', MAX_UPLOAD_BYTES + 1],
  ] as const) {
    await assert.rejects(
      storage.presign(key, mime, bytes),
      hasCode('INVALID_PHOTO_FILE')
    );
  }
  storage.onModuleDestroy();
});
test('stream byte limit terminates oversized bodies independent of declared headers', async () => {
  const body = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);
  await assert.rejects(collectBounded(body, 8), hasCode('INVALID_PHOTO_FILE'));
  assert.equal(body.destroyed, true);
  assert.deepEqual(
    await collectBounded(Readable.from([Buffer.from('ok')]), 2),
    Buffer.from('ok')
  );
});
test('all supported formats are decoded then saved under immutable variant keys', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const storage = new MemoryStorage();
    storage.input = await photo(format);
    storage.mime = `image/${format}`;
    const variants = await storage.process(
      'staging/abc',
      storage.mime,
      storage.input.length,
      `photos/${format}/attempt`
    );
    assert.deepEqual(
      variants.map((v) => v.kind),
      ['ORIGINAL', 'DISPLAY', 'THUMBNAIL']
    );
    assert.equal(variants[0].mime, storage.mime);
    assert.deepEqual(storage.written.get(variants[0].objectKey), storage.input);
    for (const variant of variants) {
      assert.equal(variant.width, 80);
      assert.equal(variant.height, 40);
      assert.equal(
        storage.written.get(variant.objectKey)!.length,
        variant.bytes
      );
    }
  }
});
test('derivatives orient pixels and remove EXIF; published original is the inspected snapshot', async () => {
  const storage = new MemoryStorage();
  storage.input = await sharp(await photo())
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const inspected = Buffer.from(storage.input);
  storage.onPut = () => {
    storage.input = Buffer.from('a later staging overwrite');
  };
  const variants = await storage.process(
    'staging/abc',
    'image/jpeg',
    inspected.length,
    'photos/photo/attempt'
  );
  assert.deepEqual(storage.written.get(variants[0].objectKey), inspected);
  assert.equal(variants[0].width, 40);
  assert.equal(variants[0].height, 80);
  for (const variant of variants.slice(1)) {
    const metadata = await sharp(
      storage.written.get(variant.objectKey)!
    ).metadata();
    assert.equal(metadata.width, 40);
    assert.equal(metadata.height, 80);
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.orientation, undefined);
  }
});
test('spoofed MIME, non-images, byte mismatch, truncation and animated files are rejected before publishing', async () => {
  const png = await photo('png');
  const jpeg = await photo();
  const frames = Buffer.alloc(2 * 2 * 3 * 2, 100);
  frames.fill(200, 12);
  const animated = await sharp(frames, {
    raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  for (const [data, mime, declared] of [
    [png, 'image/jpeg', png.length],
    [Buffer.from('<svg/>'), 'image/jpeg', 6],
    [jpeg, 'image/jpeg', jpeg.length + 1],
    [jpeg.subarray(0, jpeg.length - 10), 'image/jpeg', jpeg.length - 10],
    [animated, 'image/webp', animated.length],
  ] as const) {
    const storage = new MemoryStorage();
    storage.input = data;
    storage.mime = mime;
    await assert.rejects(
      storage.process('staging/test', mime, declared, 'photos/photo/attempt'),
      hasCode('INVALID_PHOTO_FILE')
    );
    assert.equal(storage.written.size, 0);
  }
});
test('oversized pixel dimensions are rejected before decoding an image', async () => {
  const storage = new MemoryStorage();
  storage.mime = 'image/png';
  storage.input = Buffer.from(await photo('png'));
  storage.input.writeUInt32BE(100_000, 16);
  storage.input.writeUInt32BE(100_000, 20);
  await assert.rejects(
    storage.process(
      'staging/test',
      storage.mime,
      storage.input.length,
      'photos/photo/attempt'
    ),
    hasCode('INVALID_PHOTO_FILE')
  );
  assert.equal(storage.written.size, 0);
});
test('partial publishing failure cleans this attempt and releases processing capacity', async () => {
  const storage = new MemoryStorage();
  storage.input = await photo();
  storage.failPut = 2;
  await assert.rejects(
    storage.process(
      'staging/abc',
      storage.mime,
      storage.input.length,
      'photos/photo/attempt'
    ),
    /controlled write failure/
  );
  assert.equal(storage.written.size, 0);
  assert.equal(storage.removed.length, 2);
  storage.failPut = 0;
  assert.equal(
    (
      await storage.process(
        'staging/abc',
        storage.mime,
        storage.input.length,
        'photos/photo/retry'
      )
    ).length,
    3
  );
});

test('upload and backfill extract only original capture date while preserving source bytes', async () => {
  const storage = new MemoryStorage();
  storage.input = await sharp(await photo())
    .withExif({
      IFD2: {
        DateTimeOriginal: '2020:02:29 12:30:00',
        OffsetTimeOriginal: '+09:00',
      },
    })
    .jpeg()
    .toBuffer();
  const original = Buffer.from(storage.input);
  const variants = await storage.process(
    'staging/dated',
    'image/jpeg',
    original.length,
    'photos/dated/attempt'
  );
  assert.equal(
    variants[0].capturedAt?.toISOString(),
    '2020-02-29T03:30:00.000Z'
  );
  assert.equal(variants[1].capturedAt, undefined);
  assert.deepEqual(storage.written.get(variants[0].objectKey), original);
  assert.equal(
    (
      await storage.captureDate(variants[0].objectKey, original.length)
    )?.toISOString(),
    '2020-02-29T03:30:00.000Z'
  );
  for (const variant of variants.slice(1))
    assert.equal(
      (await sharp(storage.written.get(variant.objectKey)!).metadata()).exif,
      undefined
    );
});

test('invalid optional EXIF date falls back without rejecting a valid upload or backfill', async () => {
  const storage = new MemoryStorage();
  storage.input = await sharp(await photo())
    .withExif({ IFD2: { DateTimeOriginal: '2021:02:29 12:30:00' } })
    .jpeg()
    .toBuffer();
  const original = Buffer.from(storage.input);
  const variants = await storage.process(
    'staging/invalid-date',
    'image/jpeg',
    original.length,
    'photos/invalid-date/attempt'
  );
  assert.equal(variants[0].capturedAt, null);
  assert.equal(
    await storage.captureDate(variants[0].objectKey, original.length),
    null
  );
  assert.deepEqual(storage.written.get(variants[0].objectKey), original);
});
