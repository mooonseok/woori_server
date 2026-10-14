import { Module } from '@nestjs/common';
import { MediaCleanupModule } from './media-cleanup/media-cleanup.module';
@Module({ imports: [MediaCleanupModule] })
export class WorkerModule {}
