import { PhotoProcessingModule } from './photo-processing/photo-processing.module';
import { PushModule } from '../domain/push/push.module';
import { Module } from '@nestjs/common';
import { MediaCleanupModule } from './media-cleanup/media-cleanup.module';
import { GroupCleanupModule } from './group-cleanup/group-cleanup.module';
@Module({
  imports: [
    MediaCleanupModule,
    GroupCleanupModule,
    PushModule,
    PhotoProcessingModule,
  ],
})
export class WorkerModule {}
