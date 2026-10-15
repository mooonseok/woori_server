// Operator content operations (single admin role). Every mutation and every view
// of member personal content is audited.
export const NOTICE_TITLE_MAX_LENGTH = 120;
export const NOTICE_BODY_MAX_LENGTH = 10_000;
export const ADMIN_NOTICE_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'ARCHIVED',
] as const;
// publishAt window: [now − 1 min, now + 90 days].
export const NOTICE_PUBLISH_PAST_TOLERANCE_MS = 60_000;
export const NOTICE_PUBLISH_MAX_AHEAD_MS = 90 * 24 * 60 * 60_000;
export const INQUIRY_ANSWER_MAX_LENGTH = 4000;
export const ADMIN_INQUIRY_STATUSES = [
  'RECEIVED',
  'IN_PROGRESS',
  'ANSWERED',
  'CLOSED',
] as const;
export const ADMIN_INQUIRY_STATUS_CHANGES = ['IN_PROGRESS', 'CLOSED'] as const;
export const ADMIN_REPORT_LIST_STATUSES = [
  'OPEN',
  'RECEIVED',
  'REVIEWING',
  'RESOLVED',
  'DISMISSED',
] as const;
export const OPEN_REPORT_STATUSES = ['RECEIVED', 'REVIEWING'] as const;
export const ADMIN_REPORT_ACTIONS = ['DELETE_CONTENT', 'SUSPEND_USER'] as const;
export type AdminReportAction = (typeof ADMIN_REPORT_ACTIONS)[number];
export type ReportResolution =
  'CONTENT_DELETED' | 'USER_SUSPENDED' | 'NO_ACTION';
export const ADMIN_REASON_MAX_LENGTH = 500;
export const ADMIN_VIEW_REASON_MIN_LENGTH = 5;
// Audited personal-content views per admin (photos and comments together).
export const ADMIN_VIEW_LIMIT = 120;
export const ADMIN_VIEW_WINDOW_MS = 60 * 60 * 1000;

export function publishAtError(publishAt: Date, now: Date) {
  return (
    Number.isNaN(publishAt.getTime()) ||
    publishAt.getTime() < now.getTime() - NOTICE_PUBLISH_PAST_TOLERANCE_MS ||
    publishAt.getTime() > now.getTime() + NOTICE_PUBLISH_MAX_AHEAD_MS
  );
}
