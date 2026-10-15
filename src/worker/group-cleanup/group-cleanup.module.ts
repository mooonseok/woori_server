import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { GroupCleanupRepository } from './group-cleanup.repository';
import { GroupCleanupService } from './group-cleanup.service';

@Module({
  imports: [PrismaModule],
  providers: [GroupCleanupRepository, GroupCleanupService],
  exports: [GroupCleanupService],
})
export class GroupCleanupModule {}
