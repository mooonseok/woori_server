import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { markPhotosDeleted } from '../src/domain/photos/photo-deletion';
import { GroupCleanupRepository } from '../src/worker/group-cleanup/group-cleanup.repository';
import { GroupCleanupService } from '../src/worker/group-cleanup/group-cleanup.service';

test('one pass bounds each group once and a later pass can resume unfinished groups', async () => {
  const selections: string[][] = [];
  const repository = {
    progress: async (excluded: string[]) => {
      selections.push([...excluded]);
      const groupId = ['first', 'second'].find((id) => !excluded.includes(id));
      return groupId
        ? { groupId, photos: 100, albums: 100, completed: groupId === 'second' }
        : null;
    },
  } as unknown as GroupCleanupRepository;
  const service = new GroupCleanupService(repository);
  assert.deepEqual(await service.runBatch(), {
    groups: 2,
    photos: 200,
    albums: 200,
    completed: 1,
  });
  assert.deepEqual(selections, [[], ['first'], ['first', 'second']]);
  assert.deepEqual(await service.runBatch(1), {
    groups: 1,
    photos: 100,
    albums: 100,
    completed: 0,
  });
  for (const invalid of [0, -1, 101, 1.5, NaN])
    await assert.rejects(
      service.runBatch(invalid),
      /Invalid group cleanup batch size/
    );
});

test('a failed database pass propagates and can resume from the durable group marker', async () => {
  let fail = true;
  const repository = {
    progress: async () => {
      if (fail) throw new Error('transaction rolled back');
      return null;
    },
  } as unknown as GroupCleanupRepository;
  const service = new GroupCleanupService(repository);
  await assert.rejects(service.runBatch(), /transaction rolled back/);
  fail = false;
  assert.deepEqual(await service.runBatch(), {
    groups: 0,
    photos: 0,
    albums: 0,
    completed: 0,
  });
});

test('bounded tombstones select and update the same photo IDs, release READY bytes once, and preserve upload grace', async () => {
  const expires = new Date(Date.now() + 60_000);
  const processing = new Date(Date.now() + 120_000);
  const photos = [
    {
      id: 'ready',
      status: 'READY',
      bytes: 50n,
      stagingKey: 'staging/ready',
      uploadExpiresAt: expires,
      processingUntil: null,
      variants: [{ objectKey: 'photos/ready/original.jpg' }],
    },
    {
      id: 'processing',
      status: 'PROCESSING',
      bytes: 70n,
      stagingKey: 'staging/processing',
      uploadExpiresAt: null,
      processingUntil: processing,
      variants: [],
    },
  ];
  let remaining = photos;
  let decremented = 0n;
  const jobs: Array<{
    photoId: string;
    availableAt: Date;
    objectKeys: string[];
  }> = [];
  const tx = {
    photo: {
      findMany: async (query: {
        take?: number;
        orderBy: unknown;
        where: unknown;
      }) => {
        assert.equal(query.take, 100);
        assert.deepEqual(query.orderBy, { id: 'asc' });
        assert.deepEqual(query.where, { groupId: 'group', deletedAt: null });
        return remaining;
      },
      updateMany: async (query: {
        where: { id: { in: string[] }; groupId: string };
        data: Record<string, unknown>;
      }) => {
        assert.deepEqual(
          query.where.id.in,
          photos.map((photo) => photo.id)
        );
        assert.equal(query.where.groupId, 'group');
        assert.equal(query.data.reservedBytes, 0n);
        assert.equal(query.data.processingToken, null);
        assert.equal(query.data.status, 'DELETING');
        remaining = [];
        return { count: 2 };
      },
    },
    mediaCleanupJob: {
      createMany: async (query: {
        data: typeof jobs;
        skipDuplicates: boolean;
      }) => {
        assert.equal(query.skipDuplicates, true);
        jobs.push(...query.data);
      },
    },
    group: {
      update: async (query: { data: { usedBytes: { decrement: bigint } } }) => {
        decremented += query.data.usedBytes.decrement;
      },
    },
  } as unknown as Prisma.TransactionClient;
  assert.equal(await markPhotosDeleted(tx, 'group', {}, 100), 2);
  assert.equal(await markPhotosDeleted(tx, 'group', {}, 100), 0);
  assert.equal(decremented, 50n);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.availableAt.getTime(), expires.getTime() + 15 * 60_000);
  assert.equal(
    jobs[1]?.availableAt.getTime(),
    processing.getTime() + 5 * 60_000
  );
  assert.deepEqual(jobs[0]?.objectKeys, [
    'photos/ready/original.jpg',
    'staging/ready',
  ]);
  for (const invalid of [0, -1, 101, 1.5, NaN])
    await assert.rejects(
      markPhotosDeleted(tx, 'group', {}, invalid),
      /Invalid photo deletion batch size/
    );
});
