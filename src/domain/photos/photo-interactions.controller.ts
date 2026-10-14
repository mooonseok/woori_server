import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  CommentBodyDto,
  CommentListDto,
  CommentParamsDto,
  CreateCommentDto,
  InteractionPhotoParamsDto,
  SetReactionDto,
} from './dto/photo-interactions.dto';
import { PhotoInteractionsService } from './photo-interactions.service';
@Controller('v1/photos/:photoId')
export class PhotoInteractionsController {
  constructor(private readonly service: PhotoInteractionsService) {}
  @Get('comments') list(
    @Param() p: InteractionPhotoParamsDto,
    @Query() q: CommentListDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.listComments(p.photoId, u.id, q.limit, q.cursor);
  }
  @Post('comments') create(
    @Param() p: InteractionPhotoParamsDto,
    @Body() dto: CreateCommentDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.createComment(p.photoId, u.id, dto);
  }
  @Patch('comments/:commentId') edit(
    @Param() p: CommentParamsDto,
    @Body() dto: CommentBodyDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.editComment(p.photoId, p.commentId, u.id, dto.body);
  }
  @Delete('comments/:commentId') @HttpCode(204) remove(
    @Param() p: CommentParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.deleteComment(p.photoId, p.commentId, u.id);
  }
  @Get('reactions') reactions(
    @Param() p: InteractionPhotoParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.getReactions(p.photoId, u.id);
  }
  @Put('reactions') react(
    @Param() p: InteractionPhotoParamsDto,
    @Body() dto: SetReactionDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.setReaction(p.photoId, u.id, dto.emoji);
  }
  @Delete('reactions') unreact(
    @Param() p: InteractionPhotoParamsDto,
    @CurrentUser() u: SessionUser
  ) {
    return this.service.setReaction(p.photoId, u.id, null);
  }
}
