import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GroupsService } from './groups.service';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { CreateGroupDto } from './dto/create-group.dto';
@Controller('v1/groups')
export class GroupsController {
  constructor(private readonly service: GroupsService, private readonly rate: AuthRateLimitService) {}
  @Get() list(@CurrentUser() user: { id: string }) { return this.service.list(user.id); }
  @Get(':groupId') get(@Param('groupId', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }) { return this.service.get(id, user.id); }
  @Post() async create(@Body() dto: CreateGroupDto, @CurrentUser() user: { id: string; emailVerified: boolean }) {
    await this.rate.consume(`group-create:${user.id}`, 10);
    return this.service.create(dto.name, user);
  }
}
