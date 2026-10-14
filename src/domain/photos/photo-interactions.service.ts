import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthRateLimitService } from '../auth/auth-rate-limit.service';
import { PhotoInteractionsRepository } from './photo-interactions.repository';
import type { CreateCommentDto } from './dto/photo-interactions.dto';
export function validateCommentPosition(dto: CreateCommentDto) {
  const hasX = dto.x !== undefined;
  const hasY = dto.y !== undefined;
  if (
    (dto.kind === 'GENERAL' && (hasX || hasY)) ||
    (dto.kind === 'PIN' &&
      (!hasX ||
        !hasY ||
        !Number.isFinite(dto.x) ||
        !Number.isFinite(dto.y) ||
        dto.x! < 0 ||
        dto.x! > 1 ||
        dto.y! < 0 ||
        dto.y! > 1))
  ) {
    throw new BadRequestException({
      code: 'INVALID_COMMENT_POSITION',
      message: '위치 댓글은 사진 안의 위치를 선택해 주세요.',
    });
  }
}
@Injectable()
export class PhotoInteractionsService {
  constructor(
    private readonly repository: PhotoInteractionsRepository,
    private readonly rateLimit: AuthRateLimitService
  ) {}
  listComments(
    photoId: string,
    userId: string,
    limit: number,
    cursor?: string
  ) {
    return this.repository.listComments(photoId, userId, limit, cursor);
  }
  async createComment(photoId: string, userId: string, dto: CreateCommentDto) {
    validateCommentPosition(dto);
    await this.rateLimit.consume(`photo-comment:${userId}`, 120);
    return this.repository.createComment(photoId, userId, dto);
  }
  async editComment(
    photoId: string,
    commentId: string,
    userId: string,
    body: string
  ) {
    await this.rateLimit.consume(`photo-comment:${userId}`, 120);
    return this.repository.editComment(photoId, commentId, userId, body);
  }
  async deleteComment(photoId: string, commentId: string, userId: string) {
    await this.rateLimit.consume(`photo-comment:${userId}`, 120);
    return this.repository.deleteComment(photoId, commentId, userId);
  }
  getReactions(photoId: string, userId: string) {
    return this.repository.getReactions(photoId, userId);
  }
  async setReaction(photoId: string, userId: string, emoji: string | null) {
    await this.rateLimit.consume(`photo-reaction:${userId}`, 300);
    return this.repository.setReaction(photoId, userId, emoji);
  }
}
