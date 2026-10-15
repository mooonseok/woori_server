import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { CreateGroupDto } from './create-group.dto';

export class RenameGroupDto extends CreateGroupDto {}
export class DeleteGroupDto extends CreateGroupDto {}
export class TransferGroupDto {
  @IsUUID() userId!: string;
}
export class GroupMembersDto {
  @IsOptional() @IsUUID() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 30;
}
