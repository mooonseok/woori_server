import { PushModule } from '../domain/push/push.module';
import { Module } from '@nestjs/common';
import { MediaCleanupModule } from './media-cleanup/media-cleanup.module';
@Module({ imports: [MediaCleanupModule, PushModule] })
export class WorkerModule {}
