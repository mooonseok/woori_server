import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { SessionUser } from "../../common/dto/session-user.dto";
import {
  AlbumParamsDto,
  PhotoContentDto,
  PhotoListDto,
  PhotoParamsDto,
  UploadPhotoDto,
} from "./dto/photo.dto";
import { PhotosService } from "./photos.service";
@Controller("v1/groups/:groupId/albums/:albumId")
export class PhotosController {
  constructor(private readonly service: PhotosService) {}
  @Get("photos") list(
    @Param() p: AlbumParamsDto,
    @Query() q: PhotoListDto,
    @CurrentUser() u: SessionUser,
  ) {
    return this.service.list(p.groupId, p.albumId, u.id, q.limit, q.cursor);
  }
  @Post("uploads") upload(
    @Param() p: AlbumParamsDto,
    @Body() dto: UploadPhotoDto,
    @CurrentUser() u: SessionUser,
  ) {
    return this.service.upload(p.groupId, p.albumId, u.id, dto);
  }
  @Post("photos/:photoId/complete") @HttpCode(200) complete(
    @Param() p: PhotoParamsDto,
    @CurrentUser() u: SessionUser,
  ) {
    return this.service.complete(p.groupId, p.albumId, p.photoId, u.id);
  }
  @Get("photos/:photoId/content") async content(
    @Param() p: PhotoParamsDto,
    @Query() q: PhotoContentDto,
    @CurrentUser() u: SessionUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const object = await this.service.content(
      p.groupId,
      p.albumId,
      p.photoId,
      u.id,
      q.variant,
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Vary", "Cookie");
    response.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(object.body, {
      type: object.contentType,
      length: object.byteSize,
      disposition:
        q.variant === "original"
          ? 'attachment; filename="woori-photo"'
          : "inline",
    });
  }
}
