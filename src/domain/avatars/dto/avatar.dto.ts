import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AVATAR_MAX_UPLOAD_BYTES } from '../../../common/media/media-storage.service';

export const AVATAR_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export class RequestAvatarUploadDto {
  @IsIn(AVATAR_CONTENT_TYPES) contentType!: string;
  @IsInt() @Min(1) @Max(AVATAR_MAX_UPLOAD_BYTES) bytes!: number;
}
export class CompleteAvatarUploadDto {
  @IsUUID() uploadId!: string;
}
export class AvatarParamsDto {
  @IsUUID() userId!: string;
}
export class AvatarContentDto {
  @IsOptional() @Type(() => Number) @IsIn([128, 512]) size: 128 | 512 = 128;
  // Cache key only (the current version is always served).
  @IsOptional() @Matches(/^\d{1,9}$/) v?: string;
}
