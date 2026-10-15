import { Type } from 'class-transformer';
import { IsInt, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator';
const optional = (_object: unknown, value: unknown) => value !== undefined;
export class AdminAuditLogQueryDto {
  // The id of the last item on the previous page.
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @ValidateIf(optional) @Matches(/^[A-Z][A-Z_]{2,63}$/) action?: string;
}
