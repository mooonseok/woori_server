import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BlocksController } from './blocks.controller';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';
@Module({
  imports: [AuthModule],
  controllers: [BlocksController],
  providers: [BlocksRepository, BlocksService],
})
export class BlocksModule {}
