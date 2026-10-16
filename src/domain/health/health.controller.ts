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
          push: false,
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
