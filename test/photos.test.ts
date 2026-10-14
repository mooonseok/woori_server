import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PhotosService } from "../src/domain/photos/photos.service";
import { PhotosRepository } from "../src/domain/photos/photos.repository";
import { MediaStorageService } from "../src/common/media/media-storage.service";
import { AuthRateLimitService } from "../src/domain/auth/auth-rate-limit.service";

function fixture(
  finish: () => Promise<unknown>,
  release: () => Promise<number>,
  cleanup: (keys: string[]) => Promise<void>,
) {
  const repository = {
    assertAlbum: async () => undefined,
    claim: async () => ({
      ready: false,
      token: "attempt",
      photo: {
        stagingKey: "staging/upload",
        uploadMime: "image/png",
        uploadBytes: 1n,
      },
    }),
    finish,
    release,
  } as unknown as PhotosRepository;
  const storage = {
    enabled: () => true,
    process: async () => [
      {
        kind: "ORIGINAL",
        objectKey: "photos/photo/attempt/original",
        mime: "image/png",
        width: 1,
        height: 1,
        bytes: 1,
      },
    ],
    cleanup,
  } as unknown as MediaStorageService;
  return new PhotosService(repository, storage, {
    consume: async () => undefined,
  } as unknown as AuthRateLimitService);
}

test("a lost commit response never deletes variants already published by the database", async () => {
  const cleaned: string[][] = [];
  const service = fixture(
    async () => {
      throw new Error("Commit acknowledgement lost");
    },
    async () => 0,
    async (keys) => {
      cleaned.push(keys);
    },
  );
  await assert.rejects(
    () => service.complete("group", "album", "photo", "user"),
    /Commit acknowledgement lost/,
  );
  assert.deepEqual(cleaned, []);
});

test("staging cleanup failure does not turn a successful publication into failure or delete final variants", async () => {
  const cleaned: string[][] = [];
  const photo = { id: "photo", status: "READY" };
  const service = fixture(
    async () => photo,
    async () => {
      throw new Error("Must not release READY");
    },
    async (keys) => {
      cleaned.push(keys);
      throw new Error("Storage unavailable");
    },
  );
  assert.deepEqual(await service.complete("group", "album", "photo", "user"), {
    photo,
  });
  assert.deepEqual(cleaned, [["staging/upload"]]);
});
