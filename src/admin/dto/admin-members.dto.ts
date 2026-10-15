import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  IsPlainText,
  trimText,
} from '../../common/decorators/plain-text.decorator';
import {
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_VIEW_REASON_MIN_LENGTH,
} from '../admin-content-policy';
const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => trimText(value);
export const ADMIN_USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
export const ADMIN_GROUP_STATUSES = ['ACTIVE', 'DELETING', 'DELETED'] as const;
class AdminReason {
  @Transform(trim)
  @IsPlainText(ADMIN_VIEW_REASON_MIN_LENGTH, ADMIN_REASON_MAX_LENGTH, false)
  reason!: string;
}
export class AdminUserListDto {
  // Username prefix or display name substring (case-insensitive).
  @Transform(trim)
  @ValidateIf(optional)
  @IsPlainText(1, 64, false)
  query?: string;
  @ValidateIf(optional) @IsIn(ADMIN_USER_STATUSES) status?: string;
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class AdminUserParamsDto {
  @IsUUID() userId!: string;
}
export class RenameAdminUserDto extends AdminReason {
  @Transform(trim)
  @IsPlainText(1, 80, false)
  displayName!: string;
}
export class AdminUserReasonDto extends AdminReason {}
export class DeleteAdminUserDto extends AdminReason {
  // Must equal the member's current username (normalized like login).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value
  )
  @IsString()
  @Length(1, 64)
  confirmUsername!: string;
}
export class AdminGroupListDto {
  @Transform(trim)
  @ValidateIf(optional)
  @IsPlainText(1, 100, false)
  query?: string;
  @ValidateIf(optional) @IsIn(ADMIN_GROUP_STATUSES) status?: string;
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class AdminGroupParamsDto {
  @IsUUID() groupId!: string;
}
export class AdminAlbumParamsDto extends AdminGroupParamsDto {
  @IsUUID() albumId!: string;
}
export class AdminAlbumPhotoListDto {
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(60) limit = 30;
}
