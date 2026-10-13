import { Controller, Get, Param } from '@nestjs/common';
import { AlbumsService } from './albums.service';
import { GroupParamsDto } from './dto/group-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
@Controller('v1/groups/:groupId/albums')
export class AlbumsController {
 constructor(private readonly service: AlbumsService) {}
 @Get() list(@Param() params: GroupParamsDto, @CurrentUser() user: SessionUser) { return this.service.list(params.groupId, user.id); }
}
