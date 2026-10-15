import { Controller, Get, Query } from '@nestjs/common';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminApi } from './decorators/admin-api.decorator';
import { AdminAuditLogQueryDto } from './dto/admin-audit.dto';
// MFA-verified admin sessions only (the default admin access level).
@AdminApi()
@Controller('v1/admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly service: AdminAuditLogsService) {}
  @Get()
  list(@Query() query: AdminAuditLogQueryDto) {
    return this.service.list(query);
  }
}
