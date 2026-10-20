import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  avatarObjectKey,
  MediaStorageService,
  type AvatarSize,
} from '../../common/media/media-storage.service';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { publicUser } from '../auth/auth.service';
import { AvatarsRepository, avatarStagingKey } from './avatars.repository';
import type { RequestAvatarUploadDto } from './dto/avatar.dto';

// The signed PUT and its reservation live 10 minutes (same as photos).
const UPLOAD_TTL_SECONDS = 600;
const avatarNotFound = () =>
  new NotFoundException({
    code: 'AVATAR_NOT_FOUND',
    message: '프로필 사진이 없어요.',
  });

@Injectable()
export class AvatarsService {
  constructor(
    private readonly repository: AvatarsRepository,
    private readonly storage: MediaStorageService,
    private readonly limits: AuthRateLimitService
  ) {}
  private requireStorage() {
    if (!this.storage.enabled())
      throw new ServiceUnavailableException({
        code: 'MEDIA_NOT_CONFIGURED',
        message: '사진 저장소가 아직 준비되지 않았어요.',
      });
  }
  // Profile photos are seen only inside groups, which need a confirmed email.
  private requireVerified(user: SessionUser) {
    if (!user.emailVerified)
      throw new ForbiddenException({
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: '이메일 확인 후 프로필 사진을 바꿀 수 있어요.',
      });
  }

  async requestUpload(user: SessionUser, dto: RequestAvatarUploadDto) {
    this.requireVerified(user);
    this.requireStorage();
    await this.limits.consume(`avatar-upload:${user.id}`, 10, 60 * 60_000);
    const upload = await this.repository.reserve(
      user.id,
      dto.contentType,
      dto.bytes,
      UPLOAD_TTL_SECONDS * 1000
    );
    try {
      const ticket = await this.storage.presign(
        avatarStagingKey(upload.id),
        dto.contentType,
        dto.bytes,
        UPLOAD_TTL_SECONDS
      );
      return { uploadId: upload.id, ...ticket };
    } catch (error) {
      await this.repository.release(upload.id);
      throw error;
    }
  }

  async complete(user: SessionUser, uploadId: string) {
    this.requireVerified(user);
    this.requireStorage();
    const folder = `avatars/${user.id}/${randomUUID()}`;
    const upload = await this.repository.claim(user.id, uploadId, folder);
    let written: string[];
    try {
      written = await this.storage.processAvatar(
        avatarStagingKey(uploadId),
        upload.contentType,
        upload.bytes,
        folder
      );
    } catch (error) {
      if (error instanceof BadRequestException)
        throw new BadRequestException({
          code: 'INVALID_AVATAR_FILE',
          message: '사진을 읽을 수 없어요. JPG·PNG·WebP 사진을 골라 주세요.',
        });
      throw error;
    }
    const updated = await this.repository
      .commit(user.id, uploadId, folder, upload.guardJobId)
      .catch(async (error: unknown) => {
        await this.storage.cleanup(written);
        throw error;
      });
    if (!updated) {
      await this.storage.cleanup(written);
      throw new NotFoundException({
        code: 'AVATAR_UPLOAD_NOT_FOUND',
        message: '사진 올리기 시간이 지났어요. 다시 골라 주세요.',
      });
    }
    // The staging object also has a durable cleanup job; this is the fast path.
    await this.storage.cleanup([avatarStagingKey(uploadId)]);
    return { user: publicUser(updated) };
  }

  async remove(user: SessionUser) {
    return { user: publicUser(await this.repository.remove(user.id)) };
  }

  /**
   * Avatar bytes after the same visibility check before and after the storage
   * read, so a removal or a new block during the read is honoured.
   */
  async content(viewerId: string, targetId: string, size: AvatarSize) {
    const folder = await this.repository.visibleAvatar(viewerId, targetId);
    if (!folder) throw avatarNotFound();
    this.requireStorage();
    const object = await this.storage.readAvatar(avatarObjectKey(folder, size));
    if ((await this.repository.visibleAvatar(viewerId, targetId)) !== folder)
      throw avatarNotFound();
    return object;
  }
}
