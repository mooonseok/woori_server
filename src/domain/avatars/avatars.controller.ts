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
  AvatarContentDto,
  AvatarParamsDto,
  CompleteAvatarUploadDto,
  RequestAvatarUploadDto,
} from './dto/avatar.dto';
import { AvatarsService } from './avatars.service';

@Controller('v1')
export class AvatarsController {
  constructor(private readonly service: AvatarsService) {}
  @Post('auth/profile/avatar/uploads') request(
    @Body() dto: RequestAvatarUploadDto,
    @CurrentUser() user: SessionUser
  ) {
    return this.service.requestUpload(user, dto);
  }
  @Post('auth/profile/avatar/complete') @HttpCode(200) complete(
    @Body() dto: CompleteAvatarUploadDto,
    @CurrentUser() user: SessionUser
  ) {
    return this.service.complete(user, dto.uploadId);
  }
  @Delete('auth/profile/avatar') @HttpCode(200) remove(
    @CurrentUser() user: SessionUser
  ) {
    return this.service.remove(user);
  }
  @Get('users/:userId/avatar') async content(
    @Param() p: AvatarParamsDto,
    @Query() q: AvatarContentDto,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) response: Response
  ) {
    const object = await this.service.content(user.id, p.userId, q.size);
    // Versioned URLs (?v=) change on every replace/remove, so a private day of
    // browser caching never shows a removed photo under a current URL.
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.setHeader('Vary', 'Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(object.data, {
      type: 'image/webp',
      length: object.data.length,
      disposition: 'inline',
    });
  }
}
