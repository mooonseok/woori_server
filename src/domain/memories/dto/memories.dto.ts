import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Matches,
  ValidateIf,
} from 'class-validator';
export class MemoriesQueryDto {
  @IsOptional() @IsIn(['today', 'month', 'hidden']) kind:
    'today' | 'month' | 'hidden' = 'today';
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(30) limit = 12;
}
export class CaptureDateDto {
  @ValidateIf((_object, value: unknown) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string | null;
}

export class EmptyMemoryMutationDto {}
