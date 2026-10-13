import { IsUUID } from 'class-validator';
export class GroupParamsDto { @IsUUID() groupId!: string; }
