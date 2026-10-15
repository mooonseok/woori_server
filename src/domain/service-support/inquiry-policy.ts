import type { ValidationOptions } from 'class-validator';
import {
  IsPlainText,
  isPlainText,
  trimText,
} from '../../common/decorators/plain-text.decorator';
export const INQUIRY_CATEGORIES = [
  'ACCOUNT',
  'GROUP',
  'PHOTO',
  'NOTIFICATION',
  'BUG',
  'OTHER',
] as const;
export type InquiryCategoryValue = (typeof INQUIRY_CATEGORIES)[number];
export const INQUIRY_TITLE_MAX_LENGTH = 100;
export const INQUIRY_BODY_MAX_LENGTH = 2000;
// Stored inquiries per user in the exact rolling last 24 hours.
export const INQUIRY_CREATE_LIMIT = 5;
export const INQUIRY_CREATE_WINDOW_HOURS = 24;

export const trimInquiryText = trimText;
// Runs on the trimmed value: 1..maxLength code points without control characters
// (a multiline body may keep tab, line feed and carriage return).
export function isInquiryText(
  value: unknown,
  maxLength: number,
  multiline: boolean
): value is string {
  return isPlainText(value, 1, maxLength, multiline);
}
export function IsInquiryText(
  maxLength: number,
  multiline: boolean,
  options?: ValidationOptions
) {
  return IsPlainText(1, maxLength, multiline, options);
}
