import { Injectable } from '@nestjs/common';
import { AdminReportsRepository } from './admin-reports.repository';
import type {
  AdminReportListDto,
  DismissReportDto,
  ResolveReportDto,
} from './dto/admin-content.dto';
// Reports are handled only by the operator; nobody is notified of processing.
@Injectable()
export class AdminReportsService {
  constructor(private readonly repository: AdminReportsRepository) {}
  list(query: AdminReportListDto) {
    return this.repository.list(
      query.limit,
      query.status,
      query.targetType,
      query.cursor
    );
  }
  view(adminId: string, reportId: string) {
    return this.repository.view(adminId, reportId);
  }
  review(adminId: string, reportId: string) {
    return this.repository.review(adminId, reportId);
  }
  dismiss(adminId: string, reportId: string, dto: DismissReportDto) {
    return this.repository.dismiss(adminId, reportId, dto.reason);
  }
  resolve(adminId: string, reportId: string, dto: ResolveReportDto) {
    return this.repository.resolve(adminId, reportId, dto.action, dto.reason);
  }
}
