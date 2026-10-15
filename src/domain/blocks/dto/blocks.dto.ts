import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
const optional = (_object: unknown, value: unknown) => value !== undefined;
export class BlockParamsDto {
  @IsUUID() userId!: string;
}
export class BlockListDto {
  // The blocked user's id of the last item on the previous page.
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
