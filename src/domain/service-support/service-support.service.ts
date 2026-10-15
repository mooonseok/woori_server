import { Injectable } from '@nestjs/common';
import { ServiceSupportRepository } from './service-support.repository';
import type { CreateInquiryDto } from './dto/service-support.dto';
@Injectable()
export class ServiceSupportService {
  constructor(private readonly repository: ServiceSupportRepository) {}
  listNotices(limit: number, cursor?: string) {
    return this.repository.listNotices(limit, cursor);
  }
  notice(noticeId: string) {
    return this.repository.notice(noticeId);
  }
  listInquiries(userId: string, limit: number, cursor?: string) {
    return this.repository.listInquiries(userId, limit, cursor);
  }
  inquiry(userId: string, inquiryId: string) {
    return this.repository.inquiry(userId, inquiryId);
  }
  // Validation (trim, length, control characters) already ran in the DTO pipe,
  // so the per-user quota is consumed only by valid submissions.
  createInquiry(userId: string, dto: CreateInquiryDto) {
    return this.repository.createInquiry(userId, {
      category: dto.category,
      title: dto.title,
      body: dto.body,
    });
  }
}
