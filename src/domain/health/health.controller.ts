import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Public() @Get('healthz') @Header('Cache-Control', 'no-store')
  liveness() { return { service: 'woori-api', status: 'alive', implementation: 'auth-groups', featuresReady: false }; }
  @Public() @Get('readyz') @Header('Cache-Control', 'no-store')
  async readiness() {
    try {
      // Checks the schema and restricted runtime role as well as connectivity.
      await this.prisma.client.user.findFirst({select:{id:true}});
      const mailConfigured = (process.env.MAIL_MODE==='file' && process.env.NODE_ENV!=='production' && process.env.DEV_MAIL_DIR) || (process.env.MAIL_MODE==='resend' && process.env.RESEND_API_KEY && process.env.MAIL_FROM);
      if(!mailConfigured || !process.env.WEB_ORIGIN) throw new Error('Mail not configured');
      return {status:'ready',capabilities:{authentication:true,groups:true,invitations:true,media:false,push:false}};
    } catch {
      throw new ServiceUnavailableException({status:'not_ready',code:'DEPENDENCIES_NOT_READY'});
    }
  }
}
