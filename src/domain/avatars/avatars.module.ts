import { Module } from '@nestjs/common';
import { MediaModule } from '../../common/media/media.module';
import { PrismaModule } from '../../common/modules/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AvatarsController } from './avatars.controller';
import { AvatarsRepository } from './avatars.repository';
import { AvatarsService } from './avatars.service';
@Module({
  imports: [PrismaModule, MediaModule, AuthModule],
  controllers: [AvatarsController],
  providers: [AvatarsRepository, AvatarsService],
})
export class AvatarsModule {}
