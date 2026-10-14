import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
export class CreateGroupDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 100)
  @Matches(/\S/)
  name!: string;
}
