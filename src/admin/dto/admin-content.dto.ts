import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  IsPlainText,
  trimText,
} from '../../common/decorators/plain-text.decorator';
import { INQUIRY_CATEGORIES } from '../../domain/service-support/inquiry-policy';
import { REPORT_TARGET_TYPES } from '../../domain/reports/report-policy';
import {
  ADMIN_INQUIRY_STATUS_CHANGES,
  ADMIN_INQUIRY_STATUSES,
  ADMIN_NOTICE_STATUSES,
  ADMIN_REPORT_ACTIONS,
  ADMIN_REPORT_LIST_STATUSES,
  ADMIN_REASON_MAX_LENGTH,
  ADMIN_VIEW_REASON_MIN_LENGTH,
  INQUIRY_ANSWER_MAX_LENGTH,
  NOTICE_BODY_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
} from '../admin-content-policy';
const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => trimText(value);
// Bodies of POST actions without input reject any field.
export class EmptyAdminMutationDto {}

export class AdminNoticeListDto {
  @ValidateIf(optional) @IsIn(ADMIN_NOTICE_STATUSES) status?: string;
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class AdminNoticeParamsDto {
  @IsUUID() noticeId!: string;
}
export class CreateAdminNoticeDto {
  @Transform(trim)
  @IsPlainText(1, NOTICE_TITLE_MAX_LENGTH, false)
  title!: string;
  @Transform(trim)
  @IsPlainText(1, NOTICE_BODY_MAX_LENGTH, true)
  body!: string;
}
// At least one field is required (checked by the service).
export class UpdateAdminNoticeDto {
  @Transform(trim)
  @ValidateIf(optional)
  @IsPlainText(1, NOTICE_TITLE_MAX_LENGTH, false)
  title?: string;
  @Transform(trim)
  @ValidateIf(optional)
  @IsPlainText(1, NOTICE_BODY_MAX_LENGTH, true)
  body?: string;
}
export class PublishAdminNoticeDto {
  // An explicit offset is required so the publication time is unambiguous.
  @ValidateIf(optional)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/)
  publishAt?: string;
}

export class AdminInquiryListDto {
  @ValidateIf(optional) @IsIn(ADMIN_INQUIRY_STATUSES) status?: string;
  @ValidateIf(optional) @IsIn(INQUIRY_CATEGORIES) category?: string;
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class AdminInquiryParamsDto {
  @IsUUID() inquiryId!: string;
}
export class AnswerInquiryDto {
  @Transform(trim)
  @IsPlainText(1, INQUIRY_ANSWER_MAX_LENGTH, true)
  answer!: string;
}
export class ChangeInquiryStatusDto {
  @IsIn(ADMIN_INQUIRY_STATUS_CHANGES)
  status!: (typeof ADMIN_INQUIRY_STATUS_CHANGES)[number];
}

export class AdminReportListDto {
  @IsIn(ADMIN_REPORT_LIST_STATUSES)
  status: (typeof ADMIN_REPORT_LIST_STATUSES)[number] = 'OPEN';
  @ValidateIf(optional) @IsIn(REPORT_TARGET_TYPES) targetType?: string;
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
export class AdminReportParamsDto {
  @IsUUID() reportId!: string;
}
export class DismissReportDto {
  @Transform(trim)
  @IsPlainText(1, ADMIN_REASON_MAX_LENGTH, false)
  reason!: string;
}
export class ResolveReportDto {
  @IsIn(ADMIN_REPORT_ACTIONS)
  action!: (typeof ADMIN_REPORT_ACTIONS)[number];
  @Transform(trim)
  @IsPlainText(1, ADMIN_REASON_MAX_LENGTH, false)
  reason!: string;
}

export class AdminPhotoParamsDto {
  @IsUUID() photoId!: string;
}
export class AdminCommentParamsDto {
  @IsUUID() commentId!: string;
}
export class AdminViewReasonDto {
  @Transform(trim)
  @IsPlainText(ADMIN_VIEW_REASON_MIN_LENGTH, ADMIN_REASON_MAX_LENGTH, false)
  reason!: string;
}
