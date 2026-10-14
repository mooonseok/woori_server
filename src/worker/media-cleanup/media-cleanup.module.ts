import { Module } from '@nestjs/common';
import { MediaModule } from '../../common/media/media.module';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { MediaCleanupRepository } from './media-cleanup.repository';
import { MediaCleanupService } from './media-cleanup.service';
@Module({
  imports: [PrismaModule, MediaModule],
  providers: [MediaCleanupRepository, MediaCleanupService],
  exports: [MediaCleanupService],
})
export class MediaCleanupModule {}
