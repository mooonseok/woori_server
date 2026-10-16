import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BUNDLE_POLICIES,
  acceptsActivity,
  bundleKey,
  followUpPushAt,
  isBundledKind,
  isUnread,
  navigationFor,
  openBundle,
  pushBody,
  pushSequence,
  readThroughAfter,
} from '../src/domain/notifications/notification-bundles';
import {
  ReadNotificationDto,
  ReadNotificationsDto,
} from '../src/domain/notifications/dto/notifications.dto';

const MINUTE = 60_000;
const t0 = new Date('2026-10-16T01:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

// Mirrors notification-events.ts: an activity joins the open bundle while it
// accepts it, otherwise it opens a new one with a fresh window and sequence 1.
function assign(kind: 'PHOTOS' | 'REACTION', times: number[]) {
  const bundles: { bundleUntil: Date; sequences: number[] }[] = [];
  for (const time of times) {
    const open = bundles.at(-1);
    if (open && acceptsActivity(open, at(time)))
      open.sequences.push(open.sequences.length + 1);
    else
      bundles.push({
        bundleUntil: openBundle(kind, at(time)).bundleUntil,
        sequences: [1],
      });
  }
  return bundles;
}

test('upload bundles: 10-minute window anchored on the first photo, push 2 minutes after it', () => {
  assert.deepEqual(BUNDLE_POLICIES.PHOTOS, {
    windowMs: 10 * MINUTE,
    pushDelayMs: 2 * MINUTE,
  });
  const opened = openBundle('PHOTOS', t0);
  assert.equal(opened.bundleUntil.getTime(), at(10 * MINUTE).getTime());
  assert.equal(opened.pushAt.getTime(), at(2 * MINUTE).getTime());
  assert.equal(acceptsActivity(opened, at(10 * MINUTE - 1)), true);
  assert.equal(acceptsActivity(opened, at(10 * MINUTE)), false);
  // A steady stream every 3 minutes does not stretch the window: photos at 0,
  // 3, 6 and 9 minutes share one bundle; 12 minutes opens the next one whose own
  // window runs to 22 minutes.
  const bundles = assign(
    'PHOTOS',
    [0, 3, 6, 9, 12, 15, 21.9, 22].map((m) => m * MINUTE)
  );
  assert.deepEqual(
    bundles.map((b) => b.sequences),
    [[1, 2, 3, 4], [1, 2, 3], [1]]
  );
  assert.equal(bundles[1].bundleUntil.getTime(), at(22 * MINUTE).getTime());
  // A burst of 12 photos within the window: one bundle, sequences 1..12.
  const burst = assign(
    'PHOTOS',
    Array.from({ length: 12 }, (_, index) => index * 5_000)
  );
  assert.equal(burst.length, 1);
  assert.deepEqual(
    burst[0].sequences,
    Array.from({ length: 12 }, (_, index) => index + 1)
  );
});

test('reaction bundles: 30-minute window per photo with a short push delay', () => {
  assert.deepEqual(BUNDLE_POLICIES.REACTION, {
    windowMs: 30 * MINUTE,
    pushDelayMs: MINUTE,
  });
  const bundles = assign(
    'REACTION',
    [0, 10, 29.99, 30, 59].map((m) => m * MINUTE)
  );
  assert.deepEqual(
    bundles.map((b) => b.sequences),
    [
      [1, 2, 3],
      [1, 2],
    ]
  );
  assert.equal(
    followUpPushAt('REACTION', at(5 * MINUTE)).getTime(),
    at(6 * MINUTE).getTime()
  );
  assert.equal(
    followUpPushAt('PHOTOS', at(5 * MINUTE)).getTime(),
    at(7 * MINUTE).getTime()
  );
});

test('bundle keys: same uploader + album for uploads, same photo for reactions', () => {
  const ids = { albumId: 'album-1', actorId: 'mom', photoId: 'photo-1' };
  assert.equal(bundleKey('PHOTOS', ids), 'PHOTOS:album-1:mom');
  assert.equal(
    bundleKey('PHOTOS', { ...ids, photoId: 'photo-2' }),
    bundleKey('PHOTOS', ids)
  );
  assert.notEqual(
    bundleKey('PHOTOS', { ...ids, albumId: 'album-2' }),
    bundleKey('PHOTOS', ids)
  );
  assert.notEqual(
    bundleKey('PHOTOS', { ...ids, actorId: 'dad' }),
    bundleKey('PHOTOS', ids)
  );
  assert.equal(
    bundleKey('REACTION', { ...ids, actorId: 'dad' }),
    bundleKey('REACTION', ids)
  );
  assert.notEqual(
    bundleKey('REACTION', { ...ids, photoId: 'photo-2' }),
    bundleKey('REACTION', ids)
  );
  assert.equal(isBundledKind('PHOTOS'), true);
  assert.equal(isBundledKind('REACTION'), true);
  assert.equal(isBundledKind('COMMENT'), false);
  assert.equal(isBundledKind('PIN'), false);
  assert.equal(navigationFor('PHOTOS'), 'ALBUM');
  assert.equal(navigationFor('REACTION'), 'PHOTO');
  assert.equal(navigationFor('COMMENT'), 'COMMENT');
  assert.equal(navigationFor('PIN'), 'COMMENT');
});

test('sequencing: reads are monotonic, bounded by allocation, and new activity re-opens unread', () => {
  assert.equal(readThroughAfter(0, 3, 3), 3);
  assert.equal(readThroughAfter(5, 3, 7), 5);
  for (const observed of [0, -1, 4, 1.5, Number.NaN])
    assert.throws(() => readThroughAfter(0, observed, 3), RangeError);
  // read through 3, a 4th photo arrives (unread), read through 4 (read).
  let readThrough = readThroughAfter(0, 3, 3);
  assert.equal(isUnread(readThrough, 3), false);
  assert.equal(isUnread(readThrough, 4), true);
  readThrough = readThroughAfter(readThrough, 4, 4);
  assert.equal(isUnread(readThrough, 4), false);
  // A stale observation never moves the read position backwards.
  assert.equal(readThroughAfter(readThrough, 2, 4), 4);
  assert.equal(pushSequence({ sequence: 5 }), 5);
  for (const payload of [{}, null, { sequence: 0 }, { sequence: '2' }, 7])
    assert.equal(pushSequence(payload), 1);
});

test('push text: bundle counts with preview, generic without, never URLs', () => {
  const photos = {
    kind: 'PHOTOS',
    actorName: '엄마',
    albumTitle: '제주 여행',
    count: 12,
  };
  assert.equal(
    pushBody(photos, true),
    "엄마님이 '제주 여행'에 사진 12장을 올렸어요."
  );
  assert.equal(
    pushBody({ ...photos, count: 1 }, true),
    "엄마님이 '제주 여행'에 사진 1장을 올렸어요."
  );
  const reaction = { ...photos, kind: 'REACTION', actorName: '아빠' };
  assert.equal(
    pushBody({ ...reaction, count: 1 }, true),
    '아빠님이 내 사진에 반응했어요.'
  );
  assert.equal(
    pushBody({ ...reaction, count: 3 }, true),
    '아빠님 외 2명이 내 사진에 반응했어요.'
  );
  assert.equal(
    pushBody({ ...reaction, kind: 'COMMENT', count: 1 }, true),
    '아빠님이 내 사진에 댓글을 남겼어요.'
  );
  assert.equal(
    pushBody({ ...reaction, kind: 'PIN', count: 1 }, true),
    '아빠님이 내 사진에 위치 댓글을 남겼어요.'
  );
  for (const row of [photos, reaction])
    assert.equal(pushBody(row, false), '가족의 새로운 소식이 있어요.');
  assert.doesNotMatch(pushBody(photos, true), /https?:|objectKey/);
});

test('read sequence input accepts observed bundle sequences but stays a bounded positive integer', async () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  const id = '315097d9-f1a4-4202-ad40-455124a80cc2';
  for (const throughSequence of [1, 2, 12, 2147483647])
    assert.equal(
      (
        await validate(
          plainToInstance(ReadNotificationsDto, {
            notifications: [{ id, throughSequence }],
          }),
          options
        )
      ).length,
      0
    );
  for (const throughSequence of [0, -1, 1.5, '2', null, 2147483648])
    assert.ok(
      (
        await validate(
          plainToInstance(ReadNotificationDto, { throughSequence }),
          options
        )
      ).length,
      String(throughSequence)
    );
});
