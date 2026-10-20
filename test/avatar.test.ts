import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AVATAR_MAX_UPLOAD_BYTES,
  MediaStorageService,
  collectBounded,
  type MediaStorageOptions,
} from '../src/common/media/media-storage.service';
import { avatarVersionOf } from '../src/common/dto/member-avatar';
import {
  AvatarContentDto,
  RequestAvatarUploadDto,
} from '../src/domain/avatars/dto/avatar.dto';

const options: MediaStorageOptions = {
  accountId: 'a'.repeat(32),
  accessKeyId: 'unit-test-access',
  secretAccessKey: 'unit-test-secret',
  bucket: 'unit-test-private',
};
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
class MemoryStorage extends MediaStorageService {
  input = Buffer.alloc(0);
  mime = 'image/jpeg';
  written = new Map<string, Buffer>();
  confirmed: string[] = [];
  failPut = 0;
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
    if (this.failPut === this.written.size + 1)
      throw new Error('controlled write failure');
    this.written.set(key, data);
  }
  protected override async removeAndConfirm(key: string) {
    this.confirmed.push(key);
  }
  override async cleanup(keys: string[]) {
    keys.forEach((key) => this.written.delete(key));
  }
}
const hasCode = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'getResponse' in error &&
  (error as { getResponse(): { code: string } }).getResponse().code === code;

test('avatar renditions are oriented square 512/128 WebP without metadata', async () => {
  const storage = new MemoryStorage();
  // Wide image with EXIF orientation 6 (rotated): 300x120 stored, 120x300 shown.
  storage.input = await sharp({
    create: { width: 300, height: 120, channels: 3, background: '#386aa5' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const folder = `avatars/${USER}/${TOKEN}`;
  const keys = await storage.processAvatar(
    `staging/${TOKEN}`,
    'image/jpeg',
    storage.input.length,
    folder
  );
  assert.deepEqual(keys, [`${folder}/512.webp`, `${folder}/128.webp`]);
  for (const [key, size] of [
    [`${folder}/512.webp`, 512],
    [`${folder}/128.webp`, 128],
  ] as const) {
    const meta = await sharp(storage.written.get(key)!).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, size);
    assert.equal(meta.height, size);
    assert.equal(meta.exif, undefined);
    assert.equal(meta.orientation, undefined);
  }
});

test('avatar processing rejects a mismatched type and leaves nothing on a failed write', async () => {
  const storage = new MemoryStorage();
  storage.input = await sharp({
    create: { width: 40, height: 40, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  const folder = `avatars/${USER}/${TOKEN}`;
  // Declared JPEG, actually PNG.
  await assert.rejects(
    storage.processAvatar(
      `staging/${TOKEN}`,
      'image/jpeg',
      storage.input.length,
      folder
    ),
    hasCode('INVALID_PHOTO_FILE')
  );
  storage.mime = 'image/png';
  storage.failPut = 2;
  await assert.rejects(
    storage.processAvatar(
      `staging/${TOKEN}`,
      'image/png',
      storage.input.length,
      folder
    )
  );
  assert.equal(storage.written.size, 0);
  // Only avatar folders and staging keys are accepted.
  await assert.rejects(
    storage.processAvatar(
      `staging/${TOKEN}`,
      'image/png',
      storage.input.length,
      `photos/${TOKEN}/${TOKEN}`
    ),
    hasCode('INVALID_PHOTO_FILE')
  );
  await assert.rejects(
    storage.processAvatar(
      `staging/${TOKEN}`,
      'image/png',
      AVATAR_MAX_UPLOAD_BYTES + 1,
      folder
    ),
    hasCode('INVALID_PHOTO_FILE')
  );
});

test('avatar deletion accepts only exact keys of that user, never a prefix', async () => {
  const storage = new MemoryStorage();
  const own = [
    `avatars/${USER}/${TOKEN}/512.webp`,
    `avatars/${USER}/${TOKEN}/128.webp`,
    `staging/${TOKEN}`,
  ];
  await storage.removeAvatarObjects(USER, own);
  assert.deepEqual(storage.confirmed, own);
  for (const keys of [
    [`avatars/${OTHER}/${TOKEN}/512.webp`],
    [`avatars/${USER}/${TOKEN}`],
    [`avatars/${USER}/`],
    [`photos/${TOKEN}/${TOKEN}/display.webp`],
    [`avatars/${USER}/${TOKEN}/original.jpg`],
    [],
    Array(11).fill(`staging/${TOKEN}`),
  ])
    await assert.rejects(
      storage.removeAvatarObjects(USER, keys),
      hasCode('INVALID_PHOTO_FILE')
    );
  await assert.rejects(
    storage.removeAvatarObjects('not-a-user', [`staging/${TOKEN}`]),
    hasCode('INVALID_PHOTO_FILE')
  );
});

test('avatar requests are bounded and responses expose only a version', async () => {
  for (const input of [
    { contentType: 'image/jpeg', bytes: 1 },
    { contentType: 'image/webp', bytes: AVATAR_MAX_UPLOAD_BYTES },
  ])
    assert.equal(
      (await validate(plainToInstance(RequestAvatarUploadDto, input))).length,
      0
    );
  for (const input of [
    { contentType: 'image/heic', bytes: 10 },
    { contentType: 'video/mp4', bytes: 10 },
    { contentType: 'image/jpeg', bytes: 0 },
    { contentType: 'image/jpeg', bytes: AVATAR_MAX_UPLOAD_BYTES + 1 },
    { contentType: 'image/jpeg' },
  ])
    assert.ok(
      (await validate(plainToInstance(RequestAvatarUploadDto, input))).length
    );
  const content = plainToInstance(AvatarContentDto, { size: '512', v: '3' });
  assert.equal((await validate(content)).length, 0);
  assert.equal(content.size, 512);
  for (const query of [{ size: '256' }, { v: '1a' }, { v: '1'.repeat(10) }])
    assert.ok(
      (await validate(plainToInstance(AvatarContentDto, query))).length
    );
  assert.equal(avatarVersionOf({ avatarKey: null, avatarVersion: 4 }), null);
  assert.equal(
    avatarVersionOf({
      avatarKey: `avatars/${USER}/${TOKEN}`,
      avatarVersion: 4,
    }),
    4
  );
});
