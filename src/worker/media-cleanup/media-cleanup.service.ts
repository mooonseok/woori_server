import { Injectable } from '@nestjs/common';
import { MediaStorageService } from '../../common/media/media-storage.service';
import { MediaCleanupRepository } from './media-cleanup.repository';

@Injectable()
export class MediaCleanupService {
  constructor(
    private readonly repository: MediaCleanupRepository,
    private readonly storage: MediaStorageService
  ) {}
  /** One bounded pass; callable by the worker or an isolated integration test. */
  async runBatch(limit = 10): Promise<{ completed: number; retried: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid cleanup batch size');
    const result = { completed: 0, retried: 0 };
    for (let index = 0; index < limit; index++) {
      const job = await this.repository.claim();
      if (!job) break;
      try {
        await this.storage.removePhotoObjects(job.photoId, job.objectKeys);
        if (await this.repository.complete(job)) result.completed++;
      } catch {
        // Only counts are logged by the runner: provider errors can contain credentials/URLs.
        await this.repository.retry(job);
        result.retried++;
      }
    }
    return result;
  }
}
