import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  NoticeParamsDto,
  ServiceSupportPageDto,
} from './dto/service-support.dto';
import { ServiceSupportService } from './service-support.service';
// Read-only for member sessions. Notice authoring belongs to the admin API.
@Controller('v1/notices')
export class NoticesController {
  constructor(private readonly service: ServiceSupportService) {}
  @Get() list(@Query() q: ServiceSupportPageDto) {
    return this.service.listNotices(q.limit, q.cursor);
  }
  @Get(':noticeId') get(@Param() p: NoticeParamsDto) {
    return this.service.notice(p.noticeId);
  }
}
