import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { MailService } from '../auth/mail.service';
import { MailOutboxRepository, MailOutboxService } from './mail-outbox';
// Shared by the API (enqueue + immediate attempt) and the worker (retries).
@Module({
  imports: [PrismaModule],
  providers: [MailService, MailOutboxRepository, MailOutboxService],
  exports: [MailService, MailOutboxRepository, MailOutboxService],
})
export class MailModule {}
