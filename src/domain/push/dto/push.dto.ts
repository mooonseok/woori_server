import { Type } from 'class-transformer';
import {
  IsDefined,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
export class PushEndpointDto {
  @IsString() @MaxLength(2048) endpoint!: string;
}
export class PushKeysDto {
  @IsString() @MaxLength(128) p256dh!: string;
  @IsString() @MaxLength(32) auth!: string;
}
export class PushSubscriptionDto extends PushEndpointDto {
  @IsDefined() @ValidateNested() @Type(() => PushKeysDto) keys!: PushKeysDto;
  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  expirationTime?: number | null;
}
export class PushIdDto {
  @IsUUID() id!: string;
}
