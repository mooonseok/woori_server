import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, MaxLength } from 'class-validator';
const normalize = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
export class LoginDto {
  @Transform(normalize)
  @IsString()
  @Matches(/^[a-z0-9_]{3,32}$/)
  username!: string;
  @IsString()
  @Length(12, 128)
  password!: string;
}
export class SignupDto extends LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 80)
  displayName!: string;
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
export class ConfirmEmailDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;
}

export class RecoveryRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 80)
  name!: string;
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
export class ResetPasswordDto extends ConfirmEmailDto {
  @IsString()
  @Length(12, 128)
  newPassword!: string;
}
export class UpdateProfileDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 80)
  displayName!: string;
}
