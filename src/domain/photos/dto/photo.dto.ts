import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
export class AlbumParamsDto {
  @IsUUID() groupId!: string;
  @IsUUID() albumId!: string;
}
export class PhotoParamsDto extends AlbumParamsDto {
  @IsUUID() photoId!: string;
}
export const UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  // W07-3: transcoded by the worker; at most 200 MB and 60 s (server-checked).
  'video/mp4',
  'video/quicktime',
] as const;
export class UploadPhotoDto {
  @IsString() @Length(1, 255) filename!: string;
  @IsIn(UPLOAD_CONTENT_TYPES) contentType!: string;
  // Images stay <= 30 MiB (checked by the service before any lookup).
  @IsInt() @Min(1) @Max(200 * 1024 * 1024) bytes!: number;
}
export class PhotoListDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}
export class PhotoContentDto {
  @IsOptional() @IsIn(['original', 'display', 'thumbnail']) variant:
    'original' | 'display' | 'thumbnail' = 'display';
}

export class VideoAccessDto {
  // play: inline for the viewer (Range requests); download: attachment.
  @IsOptional() @IsIn(['play', 'download']) purpose: 'play' | 'download' =
    'play';
}

export class UploadListDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
  @IsOptional() @IsIn(['true', 'false']) activeOnly?: string;
}
export class EmptyPhotoMutationDto {}
