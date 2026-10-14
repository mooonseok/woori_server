import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  InvitationsController,
  GroupInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { InvitationsRepository } from './invitations.repository';
@Module({
  imports: [AuthModule],
  controllers: [InvitationsController, GroupInvitationsController],
  providers: [InvitationsService, InvitationsRepository],
})
export class InvitationsModule {}
