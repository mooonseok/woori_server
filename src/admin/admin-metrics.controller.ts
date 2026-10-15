import { Controller, Get } from '@nestjs/common';
import { AdminMetricsRepository } from './admin-metrics.repository';
import { AdminApi } from './decorators/admin-api.decorator';
// Read-only operational counts (no member personal data, not audited).
@AdminApi()
@Controller('v1/admin/metrics')
export class AdminMetricsController {
  constructor(private readonly metrics: AdminMetricsRepository) {}
  @Get()
  snapshot() {
    return this.metrics.snapshot();
  }
}
