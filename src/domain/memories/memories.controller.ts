import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { SessionUser } from '../../common/dto/session-user.dto';
import {
  CaptureDateDto,
  MemoriesQueryDto,
  EmptyMemoryMutationDto,
} from './dto/memories.dto';
import { MemoriesService } from './memories.service';
@Controller('v1/groups/:groupId')
export class MemoriesController {
  constructor(private readonly service: MemoriesService) {}
  @Get('memories') list(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @CurrentUser() user: SessionUser,
    @Query() q: MemoriesQueryDto
  ) {
    return this.service.list(groupId, user.id, q);
  }
  @Put('memories/:photoId/hidden') @HttpCode(204) hide(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: SessionUser,
    @Body() _body: EmptyMemoryMutationDto
  ) {
    return this.service.setHidden(groupId, photoId, user.id, true);
  }
  @Delete('memories/:photoId/hidden') @HttpCode(204) restore(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: SessionUser,
    @Body() _body: EmptyMemoryMutationDto
  ) {
    return this.service.setHidden(groupId, photoId, user.id, false);
  }
  @Patch('albums/:albumId/photos/:photoId/capture-date') captureDate(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Param('albumId', ParseUUIDPipe) albumId: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: SessionUser,
    @Body() dto: CaptureDateDto
  ) {
    return this.service.captureDate(
      groupId,
      albumId,
      photoId,
      user.id,
      dto.date
    );
  }
}
