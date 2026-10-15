import { Module } from '@nestjs/common';
import { InquiriesController } from './inquiries.controller';
import { NoticesController } from './notices.controller';
import { ServiceSupportRepository } from './service-support.repository';
import { ServiceSupportService } from './service-support.service';
@Module({
  controllers: [NoticesController, InquiriesController],
  providers: [ServiceSupportRepository, ServiceSupportService],
})
export class ServiceSupportModule {}
