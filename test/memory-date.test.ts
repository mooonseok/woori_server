import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectivePhotoDate,
  memoryCalendar,
  parseManualDate,
  seoulDate,
} from '../src/domain/memories/memory-date';
test('memory dates use explicit KST calendar boundaries and leap-day anniversary policy', () => {
  assert.equal(seoulDate(new Date('2025-12-31T15:00:00Z')), '2026-01-01');
  assert.equal(seoulDate(new Date('2025-12-31T14:59:59Z')), '2025-12-31');
  assert.equal(
    memoryCalendar(new Date('2025-02-28T03:00:00Z')).includeLeapDay,
    true
  );
  assert.equal(
    memoryCalendar(new Date('2024-02-28T03:00:00Z')).includeLeapDay,
    false
  );
  assert.equal(memoryCalendar(new Date('2024-02-29T03:00:00Z')).day, 29);
  assert.equal(
    memoryCalendar(new Date('2100-02-28T03:00:00Z')).includeLeapDay,
    true
  );
  assert.equal(
    memoryCalendar(new Date('2000-02-28T03:00:00Z')).includeLeapDay,
    false
  );
});
test('manual calendar dates override EXIF without overwriting original timestamp, with upload fallback', () => {
  const p = {
    createdAt: new Date('2026-10-14T15:00:00Z'),
    capturedAt: new Date('2020-02-28T15:00:00Z'),
  };
  assert.deepEqual(
    effectivePhotoDate({
      ...p,
      manualCapturedDate: new Date('1999-05-05T00:00:00Z'),
    }),
    { effectiveDate: '1999-05-05', dateSource: 'USER' }
  );
  assert.deepEqual(effectivePhotoDate(p), {
    effectiveDate: '2020-02-29',
    dateSource: 'EXIF',
  });
  assert.deepEqual(effectivePhotoDate({ ...p, capturedAt: null }), {
    effectiveDate: '2026-10-15',
    dateSource: 'UPLOAD',
  });
});
test('manual date rejects future, invalid Gregorian, malformed and out-of-range inputs', () => {
  const now = new Date('2026-10-14T15:00:00Z');
  assert.equal(
    parseManualDate('2026-10-15', now).toISOString(),
    '2026-10-15T00:00:00.000Z'
  );
  for (const value of [
    '2026-10-16',
    '2025-02-29',
    '2024-02-30',
    '2026-2-01',
    '2026-13-01',
    '1799-12-31',
    'bad',
  ])
    assert.throws(() => parseManualDate(value, now));
  assert.equal(parseManualDate('2024-02-29', now).getUTCDate(), 29);
});
