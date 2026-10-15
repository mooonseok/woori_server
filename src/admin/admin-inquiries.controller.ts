import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AdminInquiriesService } from './admin-inquiries.service';
import { AdminApi } from './decorators/admin-api.decorator';
import { CurrentAdmin } from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminInquiryListDto,
  AdminInquiryParamsDto,
  AnswerInquiryDto,
  ChangeInquiryStatusDto,
} from './dto/admin-content.dto';
// Member inquiries: answers and status changes (MFA-verified admin sessions).
@AdminApi()
@Controller('v1/admin/inquiries')
export class AdminInquiriesController {
  constructor(private readonly service: AdminInquiriesService) {}
  @Get()
  list(@Query() query: AdminInquiryListDto) {
    return this.service.list(query);
  }
  @Get(':inquiryId')
  detail(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminInquiryParamsDto
  ) {
    return this.service.view(session.admin.id, params.inquiryId);
  }
  @Post(':inquiryId/answer')
  @HttpCode(200)
  answer(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminInquiryParamsDto,
    @Body() dto: AnswerInquiryDto
  ) {
    return this.service.answer(session.admin.id, params.inquiryId, dto);
  }
  @Post(':inquiryId/status')
  @HttpCode(200)
  status(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminInquiryParamsDto,
    @Body() dto: ChangeInquiryStatusDto
  ) {
    return this.service.changeStatus(session.admin.id, params.inquiryId, dto);
  }
}
