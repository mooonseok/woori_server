import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { GroupsService } from './groups.service';
import {
  DeleteGroupDto,
  GroupMembersDto,
  RenameGroupDto,
  TransferGroupDto,
} from './dto/manage-group.dto';

@Controller('v1/groups')
export class GroupManagementController {
  constructor(
    private readonly service: GroupsService,
    private readonly rate: AuthRateLimitService
  ) {}
  @Get(':groupId/members')
  members(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: { id: string },
    @Query() query: GroupMembersDto
  ) {
    return this.service.members(groupId, user.id, query.limit, query.after);
  }
  @Patch(':groupId')
  async rename(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: RenameGroupDto
  ) {
    await this.rate.consume(`group-manage:${user.id}`, 50);
    return this.service.rename(groupId, user.id, dto.name);
  }
  @Post(':groupId/leave')
  @HttpCode(204)
  async leave(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: { id: string }
  ) {
    await this.rate.consume(`group-manage:${user.id}`, 50);
    return this.service.leave(groupId, user.id);
  }
  @Delete(':groupId/members/:userId')
  @HttpCode(204)
  async remove(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('userId', ParseUUIDPipe) targetId: string,
    @CurrentUser() user: { id: string }
  ) {
    await this.rate.consume(`group-manage:${user.id}`, 50);
    return this.service.remove(groupId, user.id, targetId);
  }
  @Post(':groupId/ownership')
  @HttpCode(200)
  async transfer(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: TransferGroupDto
  ) {
    await this.rate.consume(`group-manage:${user.id}`, 50);
    return this.service.transfer(groupId, user.id, dto.userId);
  }
  @Delete(':groupId')
  @HttpCode(202)
  async delete(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: DeleteGroupDto
  ) {
    await this.rate.consume(`group-manage:${user.id}`, 50);
    return this.service.delete(groupId, user.id, dto.name);
  }
}
