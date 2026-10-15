import { Injectable } from '@nestjs/common';
import { AdminInquiriesRepository } from './admin-inquiries.repository';
import type {
  AdminInquiryListDto,
  AnswerInquiryDto,
  ChangeInquiryStatusDto,
} from './dto/admin-content.dto';
@Injectable()
export class AdminInquiriesService {
  constructor(private readonly repository: AdminInquiriesRepository) {}
  list(query: AdminInquiryListDto) {
    return this.repository.list(
      query.limit,
      { status: query.status, category: query.category },
      query.cursor
    );
  }
  view(adminId: string, inquiryId: string) {
    return this.repository.view(adminId, inquiryId);
  }
  answer(adminId: string, inquiryId: string, dto: AnswerInquiryDto) {
    return this.repository.answer(adminId, inquiryId, dto.answer);
  }
  changeStatus(
    adminId: string,
    inquiryId: string,
    dto: ChangeInquiryStatusDto
  ) {
    return this.repository.changeStatus(adminId, inquiryId, dto.status);
  }
}
