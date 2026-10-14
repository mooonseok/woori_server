import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  NotificationGroupParamsDto,
  NotificationListDto,
  NotificationParamsDto,
  ReadNotificationDto,
  ReadNotificationsDto,
  UpdateGroupPreferenceDto,
  UpdatePreferencesDto,
} from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@CurrentUser() u: SessionUser, @Query() q: NotificationListDto) {
    return this.service.list(u.id, q.limit, q.cursor);
  }
  @Get('preferences') preferences(@CurrentUser() u: SessionUser) {
    return this.service.preferences(u.id);
  }
  @Patch('preferences') update(
    @CurrentUser() u: SessionUser,
    @Body() dto: UpdatePreferencesDto
  ) {
    return this.service.update(u.id, dto);
  }
  @Put('preferences/groups/:groupId') group(
    @CurrentUser() u: SessionUser,
    @Param() p: NotificationGroupParamsDto,
    @Body() dto: UpdateGroupPreferenceDto
  ) {
    return this.service.group(u.id, p.groupId, dto);
  }
  @Post('read-all') @HttpCode(200) async all(
    @CurrentUser() u: SessionUser,
    @Body() dto: ReadNotificationsDto
  ) {
    return {
      updated: (await this.service.read(u.id, dto.notifications)).length,
    };
  }
  @Patch(':id/read') async read(
    @CurrentUser() u: SessionUser,
    @Param() p: NotificationParamsDto,
    @Body() dto: ReadNotificationDto
  ) {
    return (
      await this.service.read(u.id, [
        { id: p.id, throughSequence: dto.throughSequence },
      ])
    )[0];
  }
  @Get(':id/target') target(
    @CurrentUser() u: SessionUser,
    @Param() p: NotificationParamsDto
  ) {
    return this.service.target(u.id, p.id);
  }
}
