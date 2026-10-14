import { PhotoInteractionsController } from './photo-interactions.controller';
import { PhotoInteractionsService } from './photo-interactions.service';
import { PhotoInteractionsRepository } from './photo-interactions.repository';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../../common/media/media.module';
import { PhotosController } from './photos.controller';
import { PhotosRepository } from './photos.repository';
import { PhotosService } from './photos.service';
@Module({
  imports: [MediaModule, AuthModule],
  controllers: [PhotosController, PhotoInteractionsController],
  providers: [
    PhotosRepository,
    PhotosService,
    PhotoInteractionsRepository,
    PhotoInteractionsService,
  ],
})
export class PhotosModule {}
