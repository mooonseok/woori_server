import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsRepository } from './groups.repository';
@Module({ imports: [AuthModule], controllers: [GroupsController], providers: [GroupsService, GroupsRepository] })
export class GroupsModule {}
