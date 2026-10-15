import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AdminNoticesService } from './admin-notices.service';
import { AdminApi } from './decorators/admin-api.decorator';
import { CurrentAdmin } from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminNoticeListDto,
  AdminNoticeParamsDto,
  CreateAdminNoticeDto,
  EmptyAdminMutationDto,
  PublishAdminNoticeDto,
  UpdateAdminNoticeDto,
} from './dto/admin-content.dto';
// Notice authoring (MFA-verified admin sessions). No hard delete.
@AdminApi()
@Controller('v1/admin/notices')
export class AdminNoticesController {
  constructor(private readonly service: AdminNoticesService) {}
  @Get()
  list(@Query() query: AdminNoticeListDto) {
    return this.service.list(query);
  }
  @Post()
  create(
    @CurrentAdmin() session: AdminSessionContext,
    @Body() dto: CreateAdminNoticeDto
  ) {
    return this.service.create(session.admin.id, dto);
  }
  @Get(':noticeId')
  detail(@Param() params: AdminNoticeParamsDto) {
    return this.service.detail(params.noticeId);
  }
  @Patch(':noticeId')
  update(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminNoticeParamsDto,
    @Body() dto: UpdateAdminNoticeDto
  ) {
    return this.service.update(session.admin.id, params.noticeId, dto);
  }
  @Post(':noticeId/publish')
  @HttpCode(200)
  publish(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminNoticeParamsDto,
    @Body() dto: PublishAdminNoticeDto
  ) {
    return this.service.publish(session.admin.id, params.noticeId, dto);
  }
  @Post(':noticeId/archive')
  @HttpCode(200)
  archive(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminNoticeParamsDto,
    @Body() _body: EmptyAdminMutationDto
  ) {
    return this.service.archive(session.admin.id, params.noticeId);
  }
}
