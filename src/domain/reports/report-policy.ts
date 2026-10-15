// Reports are handled only by the service operator (admin API later). Filing a
// report never notifies anyone and never hides content automatically.
export const REPORT_TARGET_TYPES = ['PHOTO', 'COMMENT', 'USER'] as const;
export type ReportTargetTypeValue = (typeof REPORT_TARGET_TYPES)[number];
export const REPORT_REASONS = [
  'INAPPROPRIATE',
  'HARASSMENT',
  'PRIVACY',
  'SPAM',
  'OTHER',
] as const;
export type ReportReasonValue = (typeof REPORT_REASONS)[number];
export const REPORT_DETAIL_MAX_LENGTH = 500;
// Stored reports per reporter in the exact rolling last 24 hours.
export const REPORT_CREATE_LIMIT = 20;
export const REPORT_CREATE_WINDOW_HOURS = 24;

// Optional free text: trimmed, and blank text means no detail (stored as null).
// Non-string input is returned unchanged so validation rejects it.
export function normalizeReportDetail(value: unknown) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
