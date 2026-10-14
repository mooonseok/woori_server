import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../../common/media/media.module';
import { PhotosController } from './photos.controller';
import { PhotosRepository } from './photos.repository';
import { PhotosService } from './photos.service';
@Module({
  imports: [MediaModule, AuthModule],
  controllers: [PhotosController],
  providers: [PhotosRepository, PhotosService],
})
export class PhotosModule {}
