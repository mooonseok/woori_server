import { PhotoProcessingModule } from './photo-processing/photo-processing.module';
import { PushModule } from '../domain/push/push.module';
import { Module } from '@nestjs/common';
import { MediaCleanupModule } from './media-cleanup/media-cleanup.module';
import { StorageCleanupModule } from './storage-cleanup/storage-cleanup.module';
import { GroupCleanupModule } from './group-cleanup/group-cleanup.module';
import { MailModule } from '../domain/mail/mail.module';
import { WorkerHeartbeatRepository } from './heartbeat/worker-heartbeat.repository';
@Module({
  imports: [
    MediaCleanupModule,
    StorageCleanupModule,
    GroupCleanupModule,
    PushModule,
    PhotoProcessingModule,
    MailModule,
  ],
  providers: [WorkerHeartbeatRepository],
})
export class WorkerModule {}
