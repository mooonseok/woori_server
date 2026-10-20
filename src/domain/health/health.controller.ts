import {
  Controller,
  Get,
  Header,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MediaStorageService } from '../../common/media/media-storage.service';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { mailConfigured } from '../../common/mail/mail-config';
import { releaseRevision } from '../../common/configurations/release';
import { webPushConfig } from '../../common/push/web-push.config';

// Startup already rejects a partial or invalid push configuration; this only
// reports whether the keys are loaded, never whether a delivery succeeds.
function pushConfigured() {
  try {
    return webPushConfig() !== null;
  } catch {
    return false;
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaStorageService
  ) {}
  @Public()
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  liveness() {
    return {
      service: 'woori-api',
      status: 'alive',
      implementation: 'auth-groups-media',
      featuresReady: false,
      release: releaseRevision(),
    };
  }
  @Public()
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async readiness() {
    try {
      // Checks the schema and restricted runtime role as well as connectivity.
      await this.prisma.client.user.findFirst({ select: { id: true } });
      // Mail transport, link origin and the outbox payload key (W07-4).
      if (!mailConfigured()) throw new Error('Mail not configured');
      return {
        status: 'ready',
        capabilities: {
          authentication: true,
          groups: true,
          invitations: true,
          media: this.media.enabled(),
          push: pushConfigured(),
        },
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        code: 'DEPENDENCIES_NOT_READY',
      });
    }
  }
}
