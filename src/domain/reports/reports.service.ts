import { Injectable } from '@nestjs/common';
import { ReportsRepository } from './reports.repository';
import type { CreateReportDto } from './dto/reports.dto';
@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}
  // Validation already ran in the DTO pipe; visibility, self and duplicate checks
  // run before the per-reporter quota is consumed.
  create(userId: string, dto: CreateReportDto) {
    return this.repository.create(userId, {
      targetType: dto.targetType,
      targetId: dto.targetId,
      groupId: dto.groupId,
      reason: dto.reason,
      detail: dto.detail ?? null,
    });
  }
  list(userId: string, limit: number, cursor?: string) {
    return this.repository.list(userId, limit, cursor);
  }
}
