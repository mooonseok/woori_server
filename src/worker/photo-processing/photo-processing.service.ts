import { HttpException, Injectable } from '@nestjs/common';
import { MediaStorageService } from '../../common/media/media-storage.service';
import { PhotosRepository } from '../../domain/photos/photos.repository';

const VIDEO_CODES = new Set([
  'VIDEO_TOO_LONG',
  'VIDEO_UNSUPPORTED',
  'TRANSCODE_FAILED',
]);
// A file problem fails at once; an environment problem (timeout, tool killed
// by load/memory) is retried and becomes TRANSCODE_FAILED only on this attempt.
const LAST_INTERRUPTED_ATTEMPT = 3;
function responseCode(error: unknown) {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse() as { code?: unknown };
  return typeof body === 'object' && typeof body.code === 'string'
    ? body.code
    : undefined;
}

@Injectable()
export class PhotoProcessingService {
  // What this process is doing right now (worker heartbeat).
  busy: { job: 'photo-processing' | 'video-transcode'; since: Date } | null =
    null;
  constructor(
    private readonly repository: PhotosRepository,
    private readonly storage: MediaStorageService
  ) {}

  /**
   * One bounded pass. videos=false skips video jobs (no working ffmpeg);
   * at most one video is transcoded per pass so a pass stays short.
   * signal aborts an in-flight transcode on shutdown (retried later).
   */
  async runBatch(
    limit = 2,
    options: { videos?: boolean; signal?: AbortSignal } = {}
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new Error('Invalid processing batch size');
    const result = { completed: 0, retried: 0 };
    if (!this.storage.enabled()) return result;
    let videos = options.videos ?? true;
    for (let index = 0; index < limit; index++) {
      if (options.signal?.aborted) break;
      const failedVideos: string[] = [];
      const claim = await this.repository.claimQueued(
        (failed) => {
          if (failed.mediaKind === 'VIDEO' && failed.stagingKey)
            failedVideos.push(failed.stagingKey);
        },
        { videos }
      );
      if (failedVideos.length)
        await this.storage.cleanup(failedVideos).catch(() => undefined);
      if (!claim) break;
      const { photo, token } = claim;
      const video = photo.mediaKind === 'VIDEO';
      if (video) videos = false;
      this.busy = {
        job: video ? 'video-transcode' : 'photo-processing',
        since: new Date(),
      };
      let keys: string[] = [];
      try {
        const variants = video
          ? await this.storage.processVideo(
              photo.stagingKey!,
              photo.uploadMime!,
              Number(photo.uploadBytes),
              `photos/${photo.id}/${token}`,
              options.signal
            )
          : await this.storage.process(
              photo.stagingKey!,
              photo.uploadMime!,
              Number(photo.uploadBytes),
              `photos/${photo.id}/${token}`
            );
        keys = variants.map((variant) => variant.objectKey);
        await this.repository.finish(
          photo.groupId,
          photo.albumId,
          photo.id,
          photo.uploaderId,
          token,
          variants
        );
        // Videos: the uploaded original is never kept after a transcode.
        await this.storage.cleanup([photo.stagingKey!]).catch(() => undefined);
        result.completed++;
      } catch (error) {
        const code = responseCode(error);
        const exhausted =
          video &&
          code === 'TRANSCODE_INTERRUPTED' &&
          photo.processingAttempts >= LAST_INTERRUPTED_ATTEMPT;
        const invalid =
          exhausted ||
          (error instanceof HttpException &&
            [400, 413, 415, 422].includes(error.getStatus()));
        const videoCode = exhausted
          ? 'TRANSCODE_FAILED'
          : invalid && code && VIDEO_CODES.has(code)
            ? code
            : invalid
              ? 'VIDEO_UNSUPPORTED'
              : undefined;
        // A timeout/lost commit response may follow a successful READY transaction.
        // Only the attempt still owning the lease may remove unpublished variants.
        const failed = await this.repository.failQueuedResult(
          photo.id,
          token,
          invalid,
          video ? videoCode : undefined,
          // Shutdown stopped this attempt: handed back now, attempt not spent.
          {
            refundAttempt: code === 'MEDIA_PROCESSING_ABORTED',
            immediate: code === 'MEDIA_PROCESSING_ABORTED',
          }
        );
        if (failed.owned) {
          await this.storage.cleanup(keys).catch(() => undefined);
          // A video that will not be retried leaves no staging original behind.
          if (video && failed.terminal)
            await this.storage
              .cleanup([photo.stagingKey!])
              .catch(() => undefined);
        } else {
          // Lost the lease: a deleted photo's cleanup job takes the keys; for
          // a live photo, this attempt's own keys that no variant references
          // are removed now (its prefix is unique to this attempt).
          await this.repository.queueDeletedAttempt(photo.id, keys);
          const orphans = await this.repository
            .unreferencedKeys(photo.id, keys)
            .catch(() => [] as string[]);
          if (orphans.length)
            await this.storage.cleanup(orphans).catch(() => undefined);
        }
        result.retried++;
      } finally {
        this.busy = null;
      }
    }
    return result;
  }
}
