import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { CreateReportDto, ReportListDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';
// Members file reports and see their own processing status. Handling (status,
// resolution) belongs to the operator admin API: no member detail/cancel/update.
@Controller('v1/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}
  @Post() async create(
    @CurrentUser() u: SessionUser,
    @Body() dto: CreateReportDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const report = await this.service.create(u.id, dto);
    // A repeated report returns the original record unchanged.
    if (report.duplicate) response.status(200);
    return report;
  }
  @Get() list(@CurrentUser() u: SessionUser, @Query() q: ReportListDto) {
    return this.service.list(u.id, q.limit, q.cursor);
  }
}
