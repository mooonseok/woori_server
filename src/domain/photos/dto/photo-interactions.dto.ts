import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
export const REACTION_EMOJIS = ['❤️', '🥰', '😂', '👏', '😮'] as const;
export class InteractionPhotoParamsDto {
  @IsUUID() photoId!: string;
}
export class CommentParamsDto extends InteractionPhotoParamsDto {
  @IsUUID() commentId!: string;
}
export class CommentBodyDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 2000)
  body!: string;
}
export class CreateCommentDto extends CommentBodyDto {
  @IsIn(['GENERAL', 'PIN']) kind: 'GENERAL' | 'PIN' = 'GENERAL';
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  x?: number;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(1)
  y?: number;
}
export class CommentListDto {
  @IsOptional() @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
}
export class SetReactionDto {
  @IsIn(REACTION_EMOJIS) emoji!: (typeof REACTION_EMOJIS)[number];
}
