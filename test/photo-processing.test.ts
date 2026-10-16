import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  videoAborted,
  videoInterrupted,
  videoRejected,
  videoToolsUnavailable,
} from '../src/common/media/video-transcode';
import type { MediaStorageService } from '../src/common/media/media-storage.service';
import type { PhotosRepository } from '../src/domain/photos/photos.repository';
import { PhotoProcessingService } from '../src/worker/photo-processing/photo-processing.service';

type Job = {
  id: string;
  mediaKind: 'PHOTO' | 'VIDEO';
  processingAttempts: number;
};
// Fakes record what the worker asked for; the real queue rules are covered by
// the video/photo integration suites.
function harness(
  jobs: Job[],
  behaviour: {
    video?: (signal?: AbortSignal) => Promise<unknown>;
    owned?: boolean;
    finish?: () => Promise<void>;
    referenced?: string[];
  } = {}
) {
  const calls = {
    claims: [] as { videos?: boolean }[],
    failed: [] as unknown[][],
    cleaned: [] as string[][],
    deleted: [] as string[][],
    busyDuring: [] as unknown[],
  };
  let service: PhotoProcessingService;
  const repository = {
    claimQueued: async (
      _onFailed: unknown,
      options: { videos?: boolean } = {}
    ) => {
      calls.claims.push(options);
      const index = jobs.findIndex(
        (job) => options.videos !== false || job.mediaKind === 'PHOTO'
      );
      if (index === -1) return null;
      const [job] = jobs.splice(index, 1);
      return {
        token: `token-${job.id}`,
        photo: {
          ...job,
          groupId: 'g',
          albumId: 'a',
          uploaderId: 'u',
          stagingKey: `staging/${job.id}`,
          uploadMime: job.mediaKind === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
          uploadBytes: 10n,
        },
      };
    },
    finish: async () => behaviour.finish?.(),
    failQueuedResult: async (...args: unknown[]) => {
      calls.failed.push(args);
      return { owned: behaviour.owned ?? true, terminal: args[2] === true };
    },
    queueDeletedAttempt: async (_id: string, keys: string[]) => {
      calls.deleted.push(keys);
    },
    unreferencedKeys: async (_id: string, keys: string[]) =>
      keys.filter((key) => !(behaviour.referenced ?? []).includes(key)),
  };
  const variants = (prefix: string, names: string[]) =>
    names.map((name) => ({ objectKey: `${prefix}/${name}` }));
  const storage = {
    enabled: () => true,
    process: async (_s: string, _m: string, _b: number, prefix: string) => {
      calls.busyDuring.push(service.busy?.job);
      return variants(prefix, ['original', 'display']);
    },
    processVideo: async (
      _s: string,
      _m: string,
      _b: number,
      prefix: string,
      signal?: AbortSignal
    ) => {
      calls.busyDuring.push(service.busy?.job);
      if (behaviour.video) await behaviour.video(signal);
      return variants(prefix, ['video.mp4', 'poster.webp']);
    },
    cleanup: async (keys: string[]) => {
      calls.cleaned.push(keys);
    },
  };
  service = new PhotoProcessingService(
    repository as unknown as PhotosRepository,
    storage as unknown as MediaStorageService
  );
  return { service, calls };
}
const job = (
  id: string,
  mediaKind: Job['mediaKind'],
  processingAttempts = 1
): Job => ({ id, mediaKind, processingAttempts });

test('one video per pass; photos keep flowing; no video claims without ffmpeg', async () => {
  const run = harness([
    job('v1', 'VIDEO'),
    job('v2', 'VIDEO'),
    job('p1', 'PHOTO'),
  ]);
  assert.deepEqual(await run.service.runBatch(3), {
    completed: 2,
    retried: 0,
  });
  assert.deepEqual(
    run.calls.claims.map((claim) => claim.videos),
    [true, false, false]
  );
  assert.deepEqual(run.calls.busyDuring, [
    'video-transcode',
    'photo-processing',
  ]);
  assert.equal(run.service.busy, null);
  const photosOnly = harness([job('v3', 'VIDEO'), job('p2', 'PHOTO')]);
  assert.deepEqual(await photosOnly.service.runBatch(2, { videos: false }), {
    completed: 1,
    retried: 0,
  });
  assert.ok(photosOnly.calls.claims.every((claim) => claim.videos === false));
});

test('environment failures retry; a third interrupted transcode fails as TRANSCODE_FAILED', async () => {
  const outcome = async (error: unknown, attempts: number) => {
    const run = harness([job('v', 'VIDEO', attempts)], {
      video: async () => {
        throw error;
      },
    });
    await run.service.runBatch(1);
    return run.calls.failed[0].slice(2);
  };
  // Timeout or a kill (load/memory): retried on attempts 1 and 2 only.
  assert.deepEqual(await outcome(videoInterrupted(), 1), [
    false,
    undefined,
    { refundAttempt: false, immediate: false },
  ]);
  assert.deepEqual(await outcome(videoInterrupted(), 2), [
    false,
    undefined,
    { refundAttempt: false, immediate: false },
  ]);
  assert.deepEqual(await outcome(videoInterrupted(), 3), [
    true,
    'TRANSCODE_FAILED',
    { refundAttempt: false, immediate: false },
  ]);
  // Missing tools: an ordinary retry (a worker without ffmpeg never claims
  // videos); shutdown hands the job back at once without spending an attempt.
  assert.deepEqual(await outcome(videoToolsUnavailable(), 4), [
    false,
    undefined,
    { refundAttempt: false, immediate: false },
  ]);
  assert.deepEqual(await outcome(videoAborted(), 4), [
    false,
    undefined,
    { refundAttempt: true, immediate: true },
  ]);
  // The member's file: terminal at once with its own code.
  assert.deepEqual(await outcome(videoRejected('VIDEO_UNSUPPORTED'), 1), [
    true,
    'VIDEO_UNSUPPORTED',
    { refundAttempt: false, immediate: false },
  ]);
});

test('shutdown aborts the running transcode and stops the pass', async () => {
  const controller = new AbortController();
  const run = harness([job('v', 'VIDEO'), job('p', 'PHOTO')], {
    video: (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(videoAborted()));
        controller.abort();
      }),
  });
  assert.deepEqual(
    await run.service.runBatch(2, { signal: controller.signal }),
    { completed: 0, retried: 1 }
  );
  assert.equal(run.calls.claims.length, 1, 'No new job after the abort');
  assert.deepEqual(run.calls.failed[0][4], {
    refundAttempt: true,
    immediate: true,
  });
});

test('a lost lease removes only this attempt’s unreferenced keys', async () => {
  const run = harness([job('v', 'VIDEO')], {
    owned: false,
    finish: async () => {
      throw new Error('lease lost');
    },
    // A READY commit whose reply was lost: variants reference video.mp4.
    referenced: ['photos/v/token-v/video.mp4'],
  });
  await run.service.runBatch(1);
  assert.deepEqual(run.calls.deleted, [
    ['photos/v/token-v/video.mp4', 'photos/v/token-v/poster.webp'],
  ]);
  assert.deepEqual(run.calls.cleaned, [['photos/v/token-v/poster.webp']]);
  // Fully published (READY committed, reply lost): nothing is removed.
  const published = harness([job('w', 'VIDEO')], {
    owned: false,
    finish: async () => {
      throw new Error('lost DB commit response');
    },
    referenced: ['photos/w/token-w/video.mp4', 'photos/w/token-w/poster.webp'],
  });
  await published.service.runBatch(1);
  assert.deepEqual(published.calls.cleaned, []);
});
