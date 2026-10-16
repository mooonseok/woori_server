import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
const optional = (_object: unknown, value: unknown) => value !== undefined;
export class NotificationParamsDto {
  @IsUUID() id!: string;
}
export class NotificationGroupParamsDto {
  @IsUUID() groupId!: string;
}
export class NotificationListDto {
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 30;
}
// The latestSequence the client observed (a bundle grows past 1). The server
// also rejects a sequence that was never allocated for that notification.
export class ReadNotificationDto {
  @IsInt() @Min(1) @Max(2147483647) throughSequence!: number;
}
export class ObservedNotificationDto extends ReadNotificationDto {
  @IsUUID() id!: string;
}
export class ReadNotificationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ObservedNotificationDto)
  notifications!: ObservedNotificationDto[];
}
export class PreferenceVersionDto {
  @IsInt() @Min(0) @Max(2147483646) version!: number;
}
export class UpdatePreferencesDto extends PreferenceVersionDto {
  @ValidateIf(optional) @IsBoolean() enabled?: boolean;
  @ValidateIf(optional) @IsBoolean() photos?: boolean;
  @ValidateIf(optional) @IsBoolean() comments?: boolean;
  @ValidateIf(optional) @IsBoolean() reactions?: boolean;
  @ValidateIf(optional) @IsBoolean() join?: boolean;
  @ValidateIf(optional) @IsBoolean() memories?: boolean;
  @ValidateIf(optional) @IsBoolean() preview?: boolean;
  @ValidateIf(optional) @IsBoolean() quietEnabled?: boolean;
  @ValidateIf(optional) @IsInt() @Min(0) @Max(1439) quietStartMinute?: number;
  @ValidateIf(optional) @IsInt() @Min(0) @Max(1439) quietEndMinute?: number;
  @ValidateIf(optional) @IsString() @MaxLength(64) timeZone?: string;
}
export class UpdateGroupPreferenceDto extends PreferenceVersionDto {
  @IsIn(['DEFAULT', 'MINE', 'OFF']) mode!: 'DEFAULT' | 'MINE' | 'OFF';
}
