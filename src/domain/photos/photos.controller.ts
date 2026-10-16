import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  AlbumParamsDto,
  PhotoContentDto,
  PhotoListDto,
  PhotoParamsDto,
  UploadPhotoDto,
  UploadListDto,
  EmptyPhotoMutationDto,
  VideoAccessDto,
} from './dto/photo.dto';
import { PhotosService } from './photos.service';
@Controller('v1/groups/:groupId/albums/:albumId')
export class PhotosController {
  constructor(private readonly service: PhotosService) {}
  @Get('photos') list(
    @Param() p: AlbumParamsDto,
    @Query() q: PhotoListDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.list(p.groupId, p.albumId, u.id, q.limit, q.cursor);
  }
  @Post('uploads') upload(
    @Param() p: AlbumParamsDto,
    @Body() dto: UploadPhotoDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.upload(p.groupId, p.albumId, u.id, dto);
  }
  @Get('uploads') uploads(
    @Param() p: AlbumParamsDto,
    @Query() q: UploadListDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.uploads(
      p.groupId,
      p.albumId,
      u.id,
      q.limit,
      q.cursor,
      q.activeOnly === 'true'
    );
  }
  @Post('photos/:photoId/process') @HttpCode(202) process(
    @Param() p: PhotoParamsDto,
    @Body() _body: EmptyPhotoMutationDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.enqueue(p.groupId, p.albumId, p.photoId, u.id);
  }
  @Get('photos/:photoId/processing') processing(
    @Param() p: PhotoParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.processing(p.groupId, p.albumId, p.photoId, u.id);
  }
  @Post('photos/:photoId/complete') @HttpCode(200) complete(
    @Param() p: PhotoParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.complete(p.groupId, p.albumId, p.photoId, u.id);
  }
  @Delete('photos/:photoId') @HttpCode(204) remove(
    @Param() p: PhotoParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.remove(p.groupId, p.albumId, p.photoId, u.id);
  }
  @Get('photos/:photoId/video') async video(
    @Param() p: PhotoParamsDto,
    @Query() q: VideoAccessDto,
    @CurrentUser() u: SessionUser,
    @Res({ passthrough: true }) response: Response
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Cookie');
    return this.service.video(p.groupId, p.albumId, p.photoId, u.id, q.purpose);
  }
  @Get('photos/:photoId/content') async content(
    @Param() p: PhotoParamsDto,
    @Query() q: PhotoContentDto,
    @CurrentUser() u: SessionUser,
    @Res({ passthrough: true }) response: Response
  ) {
    const object = await this.service.content(
      p.groupId,
      p.albumId,
      p.photoId,
      u.id,
      q.variant
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(object.body, {
      type: object.contentType,
      length: object.byteSize,
      disposition:
        q.variant === 'original'
          ? `attachment; filename="woori-${p.photoId}.${object.contentType === 'image/jpeg' ? 'jpg' : object.contentType === 'image/png' ? 'png' : 'webp'}"`
          : 'inline',
    });
  }
}
