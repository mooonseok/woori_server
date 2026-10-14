import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
export class CreateAlbumDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 160)
  @Matches(/\S/)
  title!: string;
}
