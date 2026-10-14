import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MediaStorageService } from "../../common/media/media-storage.service";
import { AuthRateLimitService } from "../auth/auth-rate-limit.service";
import { PhotosRepository } from "./photos.repository";
import type { UploadPhotoDto } from "./dto/photo.dto";
@Injectable()
export class PhotosService {
  constructor(
    private readonly repository: PhotosRepository,
    private readonly storage: MediaStorageService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}
  list(
    groupId: string,
    albumId: string,
    userId: string,
    limit: number,
    cursor?: string,
  ) {
    return this.repository.list(groupId, albumId, userId, limit, cursor);
  }
  private requireStorage() {
    if (!this.storage.enabled())
      throw new ServiceUnavailableException({
        code: "MEDIA_NOT_CONFIGURED",
        message: "사진 저장소가 아직 준비되지 않았어요.",
      });
  }
  async upload(
    groupId: string,
    albumId: string,
    userId: string,
    dto: UploadPhotoDto,
  ) {
    await this.repository.assertAlbum(groupId, albumId, userId);
    this.requireStorage();
    await this.rateLimit.consume(`media-upload:${userId}`, 120);
    const photo = await this.repository.reserve(
      groupId,
      albumId,
      userId,
      dto.contentType,
      dto.bytes,
    );
    try {
      return {
        photoId: photo.id,
        ...(await this.storage.presign(
          photo.stagingKey!,
          dto.contentType,
          dto.bytes,
        )),
      };
    } catch (error) {
      await this.repository.release(photo.id, undefined, true);
      throw error;
    }
  }
  async complete(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
  ) {
    await this.repository.assertAlbum(groupId, albumId, userId);
    this.requireStorage();
    await this.rateLimit.consume(`media-complete:${userId}`, 300);
    const claim = await this.repository.claim(
      groupId,
      albumId,
      photoId,
      userId,
    );
    if (claim.ready) return { photo: this.repository.summary(claim.photo) };
    let keys: string[] = [];
    try {
      const variants = await this.storage.process(
        claim.photo.stagingKey!,
        claim.photo.uploadMime!,
        Number(claim.photo.uploadBytes),
        `photos/${photoId}/${claim.token}`,
      );
      keys = variants.map((v) => v.objectKey);
      const photo = await this.repository.finish(
        groupId,
        albumId,
        photoId,
        userId,
        claim.token,
        variants,
      );
      await this.storage
        .cleanup([claim.photo.stagingKey!])
        .catch(() => undefined);
      return { photo };
    } catch (error) {
      const invalid =
        error instanceof HttpException &&
        [400, 404, 410, 413, 415, 422].includes(error.getStatus());
      // A lost DB commit response must never delete variants already referenced by READY.
      // Only the still-owned processing attempt may release and clean its objects.
      const released = await this.repository.release(
        photoId,
        claim.token,
        invalid,
      );
      if (released) await this.storage.cleanup(keys).catch(() => undefined);
      if (invalid && released)
        await this.storage
          .cleanup([claim.photo.stagingKey!])
          .catch(() => undefined);
      throw error;
    }
  }
  async content(
    groupId: string,
    albumId: string,
    photoId: string,
    userId: string,
    kind: string,
  ) {
    const variant = await this.repository.content(
      groupId,
      albumId,
      photoId,
      userId,
      kind.toUpperCase(),
    );
    this.requireStorage();
    const object = await this.storage.read(
      variant.objectKey,
      Number(variant.bytes),
    );
    try {
      await this.repository.content(
        groupId,
        albumId,
        photoId,
        userId,
        kind.toUpperCase(),
      );
    } catch (error) {
      object.body.destroy();
      throw error;
    }
    return { ...object, contentType: variant.mime };
  }
}
