import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsRepository } from './groups.repository';
import { GroupManagementRepository } from './group-management.repository';
import { GroupManagementController } from './group-management.controller';
@Module({
  imports: [AuthModule],
  controllers: [GroupsController, GroupManagementController],
  providers: [GroupsService, GroupsRepository, GroupManagementRepository],
})
export class GroupsModule {}
