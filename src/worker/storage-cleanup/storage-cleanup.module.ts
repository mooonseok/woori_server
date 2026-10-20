import { Module } from '@nestjs/common';
import { MediaModule } from '../../common/media/media.module';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { StorageCleanupRepository } from './storage-cleanup.repository';
import { StorageCleanupService } from './storage-cleanup.service';
@Module({
  imports: [PrismaModule, MediaModule],
  providers: [StorageCleanupRepository, StorageCleanupService],
  exports: [StorageCleanupService],
})
export class StorageCleanupModule {}
