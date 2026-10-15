import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  CreateInquiryDto,
  InquiryParamsDto,
  ServiceSupportPageDto,
} from './dto/service-support.dto';
import { ServiceSupportService } from './service-support.service';
// Members submit and read only their own inquiries. Answers and status changes
// belong to the admin API, so no update route exists here.
@Controller('v1/inquiries')
export class InquiriesController {
  constructor(private readonly service: ServiceSupportService) {}
  @Post() create(@CurrentUser() u: SessionUser, @Body() dto: CreateInquiryDto) {
    return this.service.createInquiry(u.id, dto);
  }
  @Get() list(
    @CurrentUser() u: SessionUser,
    @Query() q: ServiceSupportPageDto
  ) {
    return this.service.listInquiries(u.id, q.limit, q.cursor);
  }
  @Get(':inquiryId') get(
    @CurrentUser() u: SessionUser,
    @Param() p: InquiryParamsDto
  ) {
    return this.service.inquiry(u.id, p.inquiryId);
  }
}
