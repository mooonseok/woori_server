import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { CreateInvitationDto, InvitationCredentialDto } from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';
@Controller('v1/groups/:groupId/invitations')
export class GroupInvitationsController {
  constructor(private readonly service: InvitationsService, private readonly rate: AuthRateLimitService) {}
  @Post() async create(@Param('groupId', ParseUUIDPipe) groupId: string, @CurrentUser() user: SessionUser, @Body() dto: CreateInvitationDto) {
    await this.rate.consume(`invite-create:${user.id}`, 20);
    return this.service.create(groupId, user, dto);
  }
  @Get() list(@Param('groupId', ParseUUIDPipe) groupId: string, @CurrentUser() user: SessionUser) { return this.service.list(groupId, user.id); }
  @Delete(':invitationId') @HttpCode(204)
  revoke(@Param('groupId', ParseUUIDPipe) groupId: string, @Param('invitationId', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) { return this.service.revoke(groupId, id, user.id); }
}
@Controller('v1/invitations')
export class InvitationsController {
  constructor(private readonly service: InvitationsService, private readonly rate: AuthRateLimitService) {}
  @Public() @Post('preview') @HttpCode(200)
  async preview(@Body() dto: InvitationCredentialDto, @Req() req: Request) {
    await this.rate.consume(`invite-preview:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, 30);
    return this.service.preview(dto);
  }
  @Post('join') @HttpCode(200)
  async join(@Body() dto: InvitationCredentialDto, @CurrentUser() user: SessionUser, @Req() req: Request) {
    await this.rate.consume(`invite-join-ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, 60);
    await this.rate.consume(`invite-join-user:${user.id}`, 20);
    return this.service.join(dto, user);
  }
}
