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
export class UploadPhotoDto {
  @IsString() @Length(1, 255) filename!: string;
  @IsIn(['image/jpeg', 'image/png', 'image/webp']) contentType!: string;
  @IsInt() @Min(1) @Max(30 * 1024 * 1024) bytes!: number;
}
export class PhotoListDto {
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}
export class PhotoContentDto {
  @IsOptional() @IsIn(['original', 'display', 'thumbnail']) variant:
    'original' | 'display' | 'thumbnail' = 'display';
}
