import { Injectable } from '@nestjs/common';
import { AdminAuditLogsRepository } from './admin-audit-logs.repository';
import type { AdminAuditLogQueryDto } from './dto/admin-audit.dto';
@Injectable()
export class AdminAuditLogsService {
  constructor(private readonly repository: AdminAuditLogsRepository) {}
  list(query: AdminAuditLogQueryDto) {
    return this.repository.list(query.limit, query.cursor, query.action);
  }
}
