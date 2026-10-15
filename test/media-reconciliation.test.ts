import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  reconcileMedia,
  ReconciliationStorage,
  type ReconciliationPhoto,
  type ReconciliationObjects,
} from '../src/common/media/media-reconciliation';
const now = new Date('2026-10-15T12:00:00Z'),
  old = new Date('2026-10-15T09:00:00Z');
const id = '11111111-1111-4111-8111-111111111111';
function row(patch: Partial<ReconciliationPhoto> = {}): ReconciliationPhoto {
  return {
    id,
    status: 'READY',
    deletedAt: null,
    stagingKey: `staging/${id}`,
    uploadExpiresAt: old,
    processingUntil: null,
    variants: [{ objectKey: `photos/${id}/attempt/original.jpg`, bytes: 10n }],
    ...patch,
  };
}
const clean: ReconciliationObjects = {
  list: async () => ({ objects: [], truncated: false }),
  head: async () => null,
};
test('report identifies missing references and aged unreferenced/staging without disclosing keys', async () => {
  const photo = row();
  const report = await reconcileMedia(
    { page: async () => [photo], current: async () => photo },
    {
      list: async () => ({
        objects: [
          { key: `photos/${id}/old/display.webp`, modified: old },
          { key: `photos/${id}/new/display.webp`, modified: now },
          { key: 'photos/another/key', modified: old },
        ],
        truncated: false,
      }),
      head: async (key) =>
        key.startsWith('staging/') ? { bytes: 10, modified: old } : null,
    },
    { now }
  );
  assert.deepEqual(report.reports, [
    {
      photoId: id,
      missingReferences: 1,
      sizeMismatches: 0,
      unreferencedObjects: 1,
      expiredStaging: 1,
      truncated: false,
    },
  ]);
  assert.equal(JSON.stringify(report).includes('original.jpg'), false);
});
test('queued work and recently expired lease or upload are excluded before storage access', async () => {
  const photos = [
    row({ status: 'PROCESSING', processingUntil: old }),
    row({ processingUntil: new Date(now.getTime() - 1000) }),
    row({ uploadExpiresAt: now }),
  ];
  let calls = 0;
  const report = await reconcileMedia(
    { page: async () => photos, current: async () => null },
    {
      list: async () => {
        calls++;
        throw Error();
      },
      head: async () => {
        calls++;
        throw Error();
      },
    },
    { now }
  );
  assert.equal(report.skippedActive, 3);
  assert.equal(calls, 0);
});
test('concurrent DB change discards stale findings; storage denial is never reported as missing', async () => {
  const photo = row();
  const changed = await reconcileMedia(
    {
      page: async () => [photo],
      current: async () => row({ status: 'PROCESSING' }),
    },
    clean,
    { now }
  );
  assert.equal(changed.skippedChanged, 1);
  assert.deepEqual(changed.reports, []);
  const failed = await reconcileMedia(
    { page: async () => [photo], current: async () => photo },
    {
      ...clean,
      head: async () => {
        throw new Error('sensitive provider message');
      },
    },
    { now }
  );
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.reports, []);
  assert.equal(JSON.stringify(failed).includes('sensitive'), false);
});
test('truncated object pages stay explicit and size mismatches are distinct from missing objects', async () => {
  const photo = row({ stagingKey: null });
  const result = await reconcileMedia(
    { page: async () => [photo], current: async () => photo },
    {
      list: async () => ({ objects: [], truncated: true }),
      head: async () => ({ bytes: 11, modified: old }),
    },
    { now, limit: 1 }
  );
  assert.equal(result.nextCursor, id);
  assert.equal(result.reports[0].truncated, true);
  assert.equal(result.reports[0].sizeMismatches, 1);
  assert.equal(result.reports[0].missingReferences, 0);
});
test('report rejects unbounded pages and invalid cursors before querying', async () => {
  let queried = false;
  const reader = {
    page: async () => {
      queried = true;
      return [];
    },
    current: async () => null,
  };
  for (const limit of [0, 101, 1.5])
    await assert.rejects(reconcileMedia(reader, clean, { limit }));
  await assert.rejects(reconcileMedia(reader, clean, { after: 'other/path' }));
  assert.equal(queried, false);
});
test('storage audit exposes only bounded List/Head, treats only 404 as absent', async () => {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) {
        assert.equal(command.input.MaxKeys, 1000);
        return { Contents: [], IsTruncated: false };
      }
      if (command instanceof HeadObjectCommand)
        throw { $metadata: { httpStatusCode: 404 } };
      throw Error('Unexpected mutating command');
    },
  };
  const storage = new ReconciliationStorage(client as never, 'private-test');
  await storage.list(`photos/${id}/`);
  assert.equal(await storage.head(`staging/${id}`), null);
  assert.equal(commands.length, 2);
  await assert.rejects(storage.list('photos/'));
  await assert.rejects(storage.head('../secret'));
  const denied = new ReconciliationStorage(
    {
      send: async () => {
        throw { $metadata: { httpStatusCode: 403 } };
      },
    } as never,
    'private-test'
  );
  await assert.rejects(denied.head(`staging/${id}`));
});
