import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import { MediaCleanupService } from '../src/worker/media-cleanup/media-cleanup.service';
import { CleanupClaim, MediaCleanupRepository } from '../src/worker/media-cleanup/media-cleanup.repository';
const photoId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const key = `photos/${photoId}/${attemptId}/original.jpg`;
class CleanupStorage extends MediaStorageService {
  listed = [key]; removed: string[] = []; fail = false; prefixes: string[] = [];
  protected override async listPhotoKeys(prefix: string) { this.prefixes.push(prefix); return this.listed; }
  protected override async removeAndConfirm(objectKey: string) {
    if (this.fail) throw new Error('provider failure');
    this.removed.push(objectKey); this.listed = this.listed.filter((key) => key !== objectKey);
  }
}
test('photo cleanup restricts listing and every deletion to exact generated keys', async () => {
  const storage = new CleanupStorage({});
  await storage.removePhotoObjects(photoId, [key, `staging/${attemptId}`]);
  assert.deepEqual(storage.prefixes, [`photos/${photoId}/`, `photos/${photoId}/`]);
  assert.deepEqual(storage.removed.sort(), [key, `staging/${attemptId}`].sort());
  for (const badId of ['', '..', 'photos', `${photoId}/`]) {
    await assert.rejects(storage.removePhotoObjects(badId, []));
  }
  for (const badKey of ['photos/', `photos/${attemptId}/${attemptId}/original.jpg`, 'staging/', 'staging/../secret', `photos/${photoId}/${attemptId}/originalXjpg`, `photos/${photoId}/${attemptId}/displayXwebp`]) {
    await assert.rejects(storage.removePhotoObjects(photoId, [badKey]));
  }
  storage.listed = [`photos/${attemptId}/${attemptId}/original.jpg`];
  await assert.rejects(storage.removePhotoObjects(photoId, []));
});
test('provider cleanup failure propagates so a durable job cannot be marked complete', async () => {
  const storage = new CleanupStorage({}); storage.fail = true;
  await assert.rejects(storage.removePhotoObjects(photoId, [key]), /provider failure/);
});
test('worker retries storage failure then completes idempotently on a later pass', async () => {
  const job: CleanupClaim = { id: photoId, photoId, objectKeys: [key], attempts: 1, lockToken: attemptId };
  let pending = true, failed = 0, completed = 0;
  const repository = {
    claim: async () => { if (!pending) return null; pending = false; return job; },
    retry: async () => { failed++; },
    complete: async () => { completed++; return true; },
  } as unknown as MediaCleanupRepository;
  const storage = new CleanupStorage({}); storage.fail = true;
  const service = new MediaCleanupService(repository, storage);
  assert.deepEqual(await service.runBatch(), { completed: 0, retried: 1 });
  assert.equal(failed, 1); assert.equal(completed, 0);
  pending = true; storage.fail = false;
  assert.deepEqual(await service.runBatch(), { completed: 1, retried: 0 });
  assert.equal(completed, 1);
  assert.deepEqual(await service.runBatch(), { completed: 0, retried: 0 });
});
test('lost cleanup lease cannot count a stale completion as success', async () => {
  let pending = true;
  const repository = {
    claim: async () => { if (!pending) return null; pending = false; return { id: photoId, photoId, objectKeys: [], attempts: 1, lockToken: attemptId }; },
    complete: async () => false,
    retry: async () => { throw new Error('should not retry a superseded lease'); },
  } as unknown as MediaCleanupRepository;
  assert.deepEqual(await new MediaCleanupService(repository, new CleanupStorage({})).runBatch(), { completed: 0, retried: 0 });
});

test('durable storage cleanup accepts only HEAD 404 as verified absence', async () => {
  for (const headStatus of [200, 403, 404, 500]) {
    const storage = new MediaStorageService({ accountId: 'a'.repeat(32), accessKeyId: 'test', secretAccessKey: 'test', bucket: 'test-private' });
    const calls: string[] = [];
    Reflect.set(storage, 'client', {
      send: async (command: { constructor: { name: string } }) => {
        const name = command.constructor.name; calls.push(name);
        if (name === 'ListObjectsV2Command') return { Contents: [] };
        if (name === 'HeadObjectCommand' && headStatus !== 200) throw { $metadata: { httpStatusCode: headStatus } };
        return {};
      },
    });
    if (headStatus === 404) await storage.removePhotoObjects(photoId, [key]);
    else await assert.rejects(storage.removePhotoObjects(photoId, [key]));
    assert.ok(calls.includes('DeleteObjectCommand')); assert.ok(calls.includes('HeadObjectCommand'));
  }
});
test('a remaining prefix page is retried after confirmed progress', async () => {
  class PagedStorage extends CleanupStorage {
    scans = 0;
    protected override async listPhotoKeys() { return ++this.scans === 1 ? [key] : [`photos/${photoId}/${attemptId}/display.webp`]; }
  }
  const storage = new PagedStorage({});
  await assert.rejects(storage.removePhotoObjects(photoId, []));
  assert.deepEqual(storage.removed, [key]);
});
