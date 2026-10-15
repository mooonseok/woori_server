import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import {
  INQUIRY_BODY_MAX_LENGTH,
  INQUIRY_CATEGORIES,
  INQUIRY_TITLE_MAX_LENGTH,
  IsInquiryText,
  trimInquiryText,
  type InquiryCategoryValue,
} from '../inquiry-policy';
const optional = (_object: unknown, value: unknown) => value !== undefined;
export class ServiceSupportPageDto {
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class NoticeParamsDto {
  @IsUUID() noticeId!: string;
}
export class InquiryParamsDto {
  @IsUUID() inquiryId!: string;
}
export class CreateInquiryDto {
  @IsIn(INQUIRY_CATEGORIES) category!: InquiryCategoryValue;
  @Transform(({ value }: { value: unknown }) => trimInquiryText(value))
  @IsInquiryText(INQUIRY_TITLE_MAX_LENGTH, false)
  title!: string;
  @Transform(({ value }: { value: unknown }) => trimInquiryText(value))
  @IsInquiryText(INQUIRY_BODY_MAX_LENGTH, true)
  body!: string;
}
