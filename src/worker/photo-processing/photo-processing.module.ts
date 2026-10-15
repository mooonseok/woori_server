import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { MediaModule } from '../../common/media/media.module';
import { PhotosRepository } from '../../domain/photos/photos.repository';
import { PhotoProcessingService } from './photo-processing.service';
@Module({
  imports: [PrismaModule, MediaModule],
  providers: [PhotosRepository, PhotoProcessingService],
  exports: [PhotoProcessingService],
})
export class PhotoProcessingModule {}
