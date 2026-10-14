import { AlbumParamsDto } from "../photos/dto/photo.dto";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
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
  @Patch(":albumId") rename(
    @Param() params: AlbumParamsDto,
    @Body() dto: CreateAlbumDto,
    @CurrentUser() user: SessionUser,
  ) { return this.service.rename(params.groupId, params.albumId, user.id, dto.title); }
  @Delete(":albumId") @HttpCode(204) remove(
    @Param() params: AlbumParamsDto,
    @CurrentUser() user: SessionUser,
  ) { return this.service.remove(params.groupId, params.albumId, user.id); }

}
