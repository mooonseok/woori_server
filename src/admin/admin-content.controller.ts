import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Res,
  Get,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminVideoStream } from './admin-video-ticket';
import { streamPrivateVideo } from '../common/media/video-response';
import { AdminContentService } from './admin-content.service';
import { AdminApi } from './decorators/admin-api.decorator';
import {
  CurrentAdmin,
  RequireAdminReauth,
} from './decorators/admin-access.decorator';
import type { AdminSessionContext } from './dto/admin-session.dto';
import {
  AdminCommentParamsDto,
  AdminPhotoParamsDto,
  AdminViewReasonDto,
} from './dto/admin-content.dto';
// Any member photo/comment may be viewed only through these audited actions:
// written reason + re-authentication within 10 minutes + audit row.
@AdminApi()
@Controller('v1/admin')
export class AdminContentController {
  constructor(private readonly service: AdminContentService) {}
  @RequireAdminReauth()
  @Post('photos/:photoId/view')
  @HttpCode(200)
  async viewPhoto(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminPhotoParamsDto,
    @Body() dto: AdminViewReasonDto,
    @Res({ passthrough: true }) response: Response
  ) {
    const object = await this.service.viewPhoto(
      session.admin.id,
      params.photoId,
      dto.reason
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Vary', 'Cookie');
    return new StreamableFile(object.body, {
      type: object.contentType,
      length: object.byteSize,
      disposition: 'inline',
    });
  }
  // Video: audit and recent re-authentication precede a session-bound grant.
  @RequireAdminReauth()
  @Post('photos/:photoId/video')
  @HttpCode(200)
  viewVideo(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminPhotoParamsDto,
    @Body() dto: AdminViewReasonDto,
    @Res({ passthrough: true }) response: Response
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.viewVideo(session, params.photoId, dto.reason);
  }
  @AdminVideoStream()
  @RequireAdminReauth()
  @Get('photos/:photoId/video/content')
  async videoContent(
    @Param() params: AdminPhotoParamsDto,
    @Req() request: Request,
    @Res() response: Response
  ) {
    await streamPrivateVideo(
      request,
      response,
      await this.service.videoContent(params.photoId)
    );
  }
  @RequireAdminReauth()
  @Post('comments/:commentId/view')
  @HttpCode(200)
  viewComment(
    @CurrentAdmin() session: AdminSessionContext,
    @Param() params: AdminCommentParamsDto,
    @Body() dto: AdminViewReasonDto
  ) {
    return this.service.viewComment(
      session.admin.id,
      params.commentId,
      dto.reason
    );
  }
}
