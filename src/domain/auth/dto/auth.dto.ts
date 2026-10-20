import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
const normalizeNickname = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;
const nicknamePattern = /^[\p{L}\p{N} _-]+$/u;
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
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(normalizeNickname)
  @IsString()
  @Length(2, 20)
  @Matches(nicknamePattern)
  nickname?: string;
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
  @ValidateIf(
    (object, value) => value !== undefined || object.displayName === undefined
  )
  @Transform(normalizeNickname)
  @IsString()
  @Length(2, 20)
  @Matches(nicknamePattern)
  nickname?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value
  )
  @IsString()
  @Length(1, 80)
  displayName?: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(12, 128)
  currentPassword!: string;
  @IsString()
  @Length(12, 128)
  newPassword!: string;
}
export class RequestEmailChangeDto {
  @IsString()
  @Length(12, 128)
  currentPassword!: string;
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  newEmail!: string;
}

export class DeleteAccountDto {
  @IsString()
  @Length(12, 128)
  currentPassword!: string;
  @Equals('탈퇴')
  confirmation!: string;
}
