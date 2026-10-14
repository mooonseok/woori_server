import { Module } from '@nestjs/common';
import { MediaModule } from '../../common/media/media.module';
import { HealthController } from './health.controller';
@Module({ imports: [MediaModule], controllers: [HealthController] })
export class HealthModule {}
