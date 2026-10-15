import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AdminReportsService } from './admin-reports.service';
import { AdminApi } from './decorators/admin-api.decorator';
import {
  CurrentAdmin,
  RequireAdminReauth,
} from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminReportListDto,
  AdminReportParamsDto,
  DismissReportDto,
  EmptyAdminMutationDto,
  ResolveReportDto,
} from './dto/admin-content.dto';
@AdminApi()
@Controller('v1/admin/reports')
export class AdminReportsController {
  constructor(private readonly service: AdminReportsService) {}
  @Get()
  list(@Query() query: AdminReportListDto) {
    return this.service.list(query);
  }
  @Get(':reportId')
  detail(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminReportParamsDto
  ) {
    return this.service.view(session.admin.id, params.reportId);
  }
  @Post(':reportId/review')
  @HttpCode(200)
  review(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminReportParamsDto,
    @Body() _body: EmptyAdminMutationDto
  ) {
    return this.service.review(session.admin.id, params.reportId);
  }
  @Post(':reportId/dismiss')
  @HttpCode(200)
  dismiss(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminReportParamsDto,
    @Body() dto: DismissReportDto
  ) {
    return this.service.dismiss(session.admin.id, params.reportId, dto);
  }
  // Deleting content or suspending a member requires a recent re-authentication.
  @RequireAdminReauth()
  @Post(':reportId/resolve')
  @HttpCode(200)
  resolve(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminReportParamsDto,
    @Body() dto: ResolveReportDto
  ) {
    return this.service.resolve(session.admin.id, params.reportId, dto);
  }
}
