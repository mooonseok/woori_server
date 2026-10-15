import { HttpException, Injectable } from '@nestjs/common';
import { MediaStorageService } from '../../common/media/media-storage.service';
import { PhotosRepository } from '../../domain/photos/photos.repository';

@Injectable()
export class PhotoProcessingService {
  constructor(
    private readonly repository: PhotosRepository,
    private readonly storage: MediaStorageService
  ) {}

  async runBatch(limit = 2) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 30)
      throw new Error('Invalid processing batch size');
    const result = { completed: 0, retried: 0 };
    if (!this.storage.enabled()) return result;
    for (let index = 0; index < limit; index++) {
      const claim = await this.repository.claimQueued();
      if (!claim) break;
      const { photo, token } = claim;
      let keys: string[] = [];
      try {
        const variants = await this.storage.process(
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
        await this.storage.cleanup([photo.stagingKey!]).catch(() => undefined);
        result.completed++;
      } catch (error) {
        const invalid =
          error instanceof HttpException &&
          [400, 413, 415, 422].includes(error.getStatus());
        // A timeout/lost commit response may follow a successful READY transaction.
        // Only the attempt still owning the lease may remove unpublished variants.
        if (await this.repository.failQueued(photo.id, token, invalid)) {
          await this.storage.cleanup(keys).catch(() => undefined);
        } else {
          await this.repository.queueDeletedAttempt(photo.id, keys);
        }
        result.retried++;
      }
    }
    return result;
  }
}
