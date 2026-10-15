import { Module } from '@nestjs/common';
import { MediaModule } from '../common/media/media.module';
import { AuthModule } from '../domain/auth/auth.module';
import { AdminContentController } from './admin-content.controller';
import { AdminContentRepository } from './admin-content.repository';
import { AdminContentService } from './admin-content.service';
import { AdminGroupsController } from './admin-groups.controller';
import { AdminGroupsRepository } from './admin-groups.repository';
import { AdminGroupsService } from './admin-groups.service';
import { AdminInquiriesController } from './admin-inquiries.controller';
import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsRepository } from './admin-metrics.repository';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersRepository } from './admin-users.repository';
import { AdminUsersService } from './admin-users.service';
import { AdminInquiriesRepository } from './admin-inquiries.repository';
import { AdminInquiriesService } from './admin-inquiries.service';
import { AdminNoticesController } from './admin-notices.controller';
import { AdminNoticesRepository } from './admin-notices.repository';
import { AdminNoticesService } from './admin-notices.service';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsRepository } from './admin-reports.repository';
import { AdminReportsService } from './admin-reports.service';
import { AdminAuditLogsController } from './admin-audit-logs.controller';
import { AdminAuditLogsRepository } from './admin-audit-logs.repository';
import { AdminAuditLogsService } from './admin-audit-logs.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthRepository } from './admin-auth.repository';
import { AdminAuthService } from './admin-auth.service';
import { AdminController } from './admin.controller';
import { AdminSessionGuard } from './guards/admin-session.guard';
// AdminController (catch-all) must stay the last controller so specific admin
// routes are matched first.
@Module({
  imports: [AuthModule, MediaModule],
  controllers: [
    AdminAuthController,
    AdminAuditLogsController,
    AdminNoticesController,
    AdminInquiriesController,
    AdminReportsController,
    AdminContentController,
    AdminUsersController,
    AdminGroupsController,
    AdminMetricsController,
    AdminController,
  ],
  providers: [
    AdminGroupsRepository,
    AdminGroupsService,
    AdminMetricsRepository,
    AdminUsersRepository,
    AdminUsersService,
    AdminContentRepository,
    AdminContentService,
    AdminInquiriesRepository,
    AdminInquiriesService,
    AdminNoticesRepository,
    AdminNoticesService,
    AdminReportsRepository,
    AdminReportsService,
    AdminAuthRepository,
    AdminAuthService,
    AdminAuditLogsRepository,
    AdminAuditLogsService,
    AdminSessionGuard,
  ],
})
export class AdminModule {}
