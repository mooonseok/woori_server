import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MediaStorageService } from '../common/media/media-storage.service';
import { AuthRateLimitService } from '../domain/auth/auth-rate-limit.service';
import { ADMIN_VIEW_LIMIT, ADMIN_VIEW_WINDOW_MS } from './admin-content-policy';
import {
  AdminContentRepository,
  photoNotFound,
} from './admin-content.repository';
// Audited views of member content: written reason, recent re-authentication
// (guard) and a per-admin rate limit that bounds bulk scraping.
@Injectable()
export class AdminContentService {
  constructor(
    private readonly repository: AdminContentRepository,
    private readonly storage: MediaStorageService,
    private readonly limits: AuthRateLimitService
  ) {}
  private consumeView(adminId: string) {
    return this.limits.consume(
      `admin-view:${adminId}`,
      ADMIN_VIEW_LIMIT,
      ADMIN_VIEW_WINDOW_MS
    );
  }
  async viewPhoto(adminId: string, photoId: string, reason: string) {
    await this.consumeView(adminId);
    const photo = await this.repository.viewablePhoto(photoId);
    if (!this.storage.enabled())
      throw new ServiceUnavailableException({
        code: 'MEDIA_NOT_CONFIGURED',
        message: '사진 저장소가 아직 준비되지 않았어요.',
      });
    // The view is recorded before any byte is read.
    await this.repository.auditPhotoView(adminId, photo, reason);
    try {
      const object = await this.storage.read(
        photo.variant.objectKey,
        Number(photo.variant.bytes)
      );
      return { ...object, contentType: photo.variant.mime };
    } catch (error) {
      // A deleting photo whose objects are already gone is simply not viewable.
      if (photo.status !== 'READY') photoNotFound();
      throw error;
    }
  }
  async viewComment(adminId: string, commentId: string, reason: string) {
    await this.consumeView(adminId);
    return this.repository.viewComment(adminId, commentId, reason);
  }
}
