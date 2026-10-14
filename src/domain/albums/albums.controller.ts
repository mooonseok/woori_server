import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CreateAlbumDto } from "./dto/create-album.dto";
import { AlbumsService } from "./albums.service";
import { GroupParamsDto } from "./dto/group-params.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { SessionUser } from "../../common/dto/session-user.dto";
@Controller("v1/groups/:groupId/albums")
export class AlbumsController {
  constructor(private readonly service: AlbumsService) {}
  @Post() create(
    @Param() params: GroupParamsDto,
    @Body() dto: CreateAlbumDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.create(params.groupId, user.id, dto.title);
  }
  @Get() list(
    @Param() params: GroupParamsDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.service.list(params.groupId, user.id);
  }
}
