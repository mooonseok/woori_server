import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import { BlockListDto, BlockParamsDto } from './dto/blocks.dto';
import { BlocksService } from './blocks.service';
// Personal, one-directional blocks ("나에게만 숨김"). The blocked user is not
// notified and memberships/roles never change.
@Controller('v1/blocks')
export class BlocksController {
  constructor(private readonly service: BlocksService) {}
  @Get() list(@CurrentUser() u: SessionUser, @Query() q: BlockListDto) {
    return this.service.list(u.id, q.limit, q.cursor);
  }
  @Put(':userId') block(
    @CurrentUser() u: SessionUser,
    @Param() p: BlockParamsDto,
    @Req() request: Request
  ) {
    return this.service.block(u.id, p.userId, request);
  }
  @Delete(':userId') @HttpCode(204) async unblock(
    @CurrentUser() u: SessionUser,
    @Param() p: BlockParamsDto
  ) {
    await this.service.unblock(u.id, p.userId);
  }
}
