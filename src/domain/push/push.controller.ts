import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { PushService } from './push.service';
import {
  PushEndpointDto,
  PushIdDto,
  PushSubscriptionDto,
} from './dto/push.dto';
@Controller('v1/push')
export class PushController {
  constructor(private readonly service: PushService) {}
  @Get('config') @Header('Cache-Control', 'no-store') config() {
    return this.service.config();
  }
  @Post('subscriptions') register(
    @CurrentUser() u: SessionUser,
    @Req() r: Request,
    @Body() dto: PushSubscriptionDto
  ) {
    return this.service.register(u.id, r, dto);
  }
  @Post('subscriptions/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  status(
    @CurrentUser() u: SessionUser,
    @Req() r: Request,
    @Body() dto: PushEndpointDto
  ) {
    return this.service.status(u.id, r, dto.endpoint);
  }
  @Delete('subscriptions/:id') @HttpCode(204) revoke(
    @CurrentUser() u: SessionUser,
    @Req() r: Request,
    @Param() p: PushIdDto
  ) {
    return this.service.revoke(u.id, r, p.id);
  }
  @Get('deliveries/:id/display') @Header('Cache-Control', 'no-store') display(
    @CurrentUser() u: SessionUser,
    @Req() r: Request,
    @Param() p: PushIdDto
  ) {
    return this.service.display(u.id, r, p.id);
  }
}
