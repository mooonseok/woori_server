import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_USERNAME_PATTERN,
} from '../admin-policy';
const normalize = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
export class AdminLoginDto {
  @Transform(normalize)
  @IsString()
  @Matches(ADMIN_USERNAME_PATTERN)
  username!: string;
  @IsString()
  @Length(ADMIN_PASSWORD_MIN_LENGTH, ADMIN_PASSWORD_MAX_LENGTH)
  password!: string;
}
export class AdminMfaCodeDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
export class AdminReauthDto extends AdminMfaCodeDto {
  @IsString()
  @Length(ADMIN_PASSWORD_MIN_LENGTH, ADMIN_PASSWORD_MAX_LENGTH)
  password!: string;
}
