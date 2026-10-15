import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { IsPlainText } from '../../../common/decorators/plain-text.decorator';
import {
  normalizeReportDetail,
  REPORT_DETAIL_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  type ReportReasonValue,
  type ReportTargetTypeValue,
} from '../report-policy';
const optional = (_object: unknown, value: unknown) => value !== undefined;
export class CreateReportDto {
  @IsIn(REPORT_TARGET_TYPES) targetType!: ReportTargetTypeValue;
  @IsUUID() targetId!: string;
  // A member report names the shared group; photo and comment reports derive it
  // and only verify a supplied value.
  @ValidateIf(
    (object: CreateReportDto, value: unknown) =>
      object.targetType === 'USER' || value !== undefined
  )
  @IsUUID()
  groupId?: string;
  @IsIn(REPORT_REASONS) reason!: ReportReasonValue;
  @Transform(({ value }: { value: unknown }) => normalizeReportDetail(value))
  @ValidateIf(
    (_object, value: unknown) => value !== undefined && value !== null
  )
  @IsPlainText(1, REPORT_DETAIL_MAX_LENGTH, true)
  detail?: string | null;
}
export class ReportListDto {
  @ValidateIf(optional) @IsUUID() cursor?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(50) limit = 20;
}
