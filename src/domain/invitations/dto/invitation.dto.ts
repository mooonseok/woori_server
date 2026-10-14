import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
export class CreateInvitationDto {
  @IsOptional() @IsInt() @Min(24) @Max(168) expiresInHours?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) maxUses?: number;
}
export class InvitationCredentialDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value
  )
  @IsString()
  @Matches(/^[0-9A-HJKMNP-TV-Z]{10}$/)
  code?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token?: string;
}
