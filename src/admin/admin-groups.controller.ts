import { Controller, Get, Param, Query } from '@nestjs/common';
import { AdminGroupsService } from './admin-groups.service';
import { AdminApi } from './decorators/admin-api.decorator';
import { CurrentAdmin } from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminAlbumParamsDto,
  AdminAlbumPhotoListDto,
  AdminGroupListDto,
  AdminGroupParamsDto,
} from './dto/admin-members.dto';
@AdminApi()
@Controller('v1/admin/groups')
export class AdminGroupsController {
  constructor(private readonly service: AdminGroupsService) {}
  @Get()
  list(@Query() query: AdminGroupListDto) {
    return this.service.list(query);
  }
  @Get(':groupId')
  detail(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminGroupParamsDto
  ) {
    return this.service.view(session.admin.id, params.groupId);
  }
  @Get(':groupId/albums/:albumId/photos')
  albumPhotos(
    @Param() params: AdminAlbumParamsDto,
    @Query() query: AdminAlbumPhotoListDto
  ) {
    return this.service.albumPhotos(params.groupId, params.albumId, query);
  }
}
