import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { adminConfig } from '../common/configurations/admin.config';
import { adminNotConfigured } from './admin-auth.service';
import { createAdminVideoTicket } from './admin-video-ticket';
import type { AdminSessionContext } from './dto/admin-session.dto';
import type { PrivateVideo } from '../common/media/video-response';
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
  // Reason/audit precedes a server-signed, session-bound media grant.
  async viewVideo(
    session: AdminSessionContext,
    photoId: string,
    reason: string
  ) {
    await this.consumeView(session.admin.id);
    const video = await this.repository.viewableVideo(photoId);
    if (!this.storage.enabled())
      throw new ServiceUnavailableException({ code: 'MEDIA_NOT_CONFIGURED' });
    const audit = await this.repository.auditVideoView(
      session.admin.id,
      video,
      reason
    );
    const grant = createAdminVideoTicket(
      adminConfig() ?? adminNotConfigured(),
      session,
      photoId,
      audit.id
    );
    return {
      url: `/v1/admin/photos/${photoId}/video/content?ticket=${grant.ticket}`,
      expiresAt: grant.expiresAt,
      mime: video.variant.mime,
      bytes: Number(video.variant.bytes),
      durationMs: video.durationMs,
    };
  }
  async videoContent(photoId: string): Promise<PrivateVideo> {
    const video = await this.repository.viewableVideo(photoId);
    if (!this.storage.enabled())
      throw new ServiceUnavailableException({ code: 'MEDIA_NOT_CONFIGURED' });
    return {
      bytes: Number(video.variant.bytes),
      open: async (range, signal) => {
        const body = await this.storage.openVideo(
          video.variant.objectKey,
          Number(video.variant.bytes),
          range,
          signal
        );
        try {
          await this.repository.viewableVideo(photoId);
        } catch (error) {
          body.destroy();
          throw error;
        }
        if (body.errored)
          throw new ServiceUnavailableException({
            code: 'MEDIA_STORAGE_UNAVAILABLE',
          });
        return body;
      },
    };
  }
  async viewComment(adminId: string, commentId: string, reason: string) {
    await this.consumeView(adminId);
    return this.repository.viewComment(adminId, commentId, reason);
  }
}
