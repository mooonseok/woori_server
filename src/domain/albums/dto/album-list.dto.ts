import { Type } from 'class-transformer';
import { Allow, IsInt, Max, Min } from 'class-validator';
export class AlbumListQueryDto {
  // Opaque page cursor. Its format is checked by the repository so a malformed,
  // repeated or stale value is always 400 ALBUM_CURSOR_INVALID (clients restart
  // from the first page on any *_CURSOR_INVALID), never a generic DTO error.
  @Allow() cursor?: unknown;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}
