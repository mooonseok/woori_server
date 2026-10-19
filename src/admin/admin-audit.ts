import type { Prisma } from '@prisma/client';
// Append-only operator audit trail. Rows never contain passwords, tokens, TOTP
// secrets or codes, cookies, raw IP addresses, email addresses or member-written
// text: metadata is limited to the keys below with enum/number/boolean values,
// and *Id keys hold UUIDs only. The admin-entered reason is the only free text.
export const ADMIN_AUDIT_ACTIONS = [
  'ADMIN_CREATED_BY_CLI',
  'ADMIN_LOGIN_FAILED',
  'ADMIN_LOCKED',
  'ADMIN_MFA_FAILED',
  'ADMIN_MFA_ENABLED',
  'ADMIN_LOGIN_SUCCEEDED',
  'ADMIN_REAUTHENTICATED',
  'ADMIN_REAUTH_FAILED',
  'ADMIN_LOGGED_OUT',
  'ADMIN_MFA_RESET_BY_CLI',
  'ADMIN_DISABLED_BY_CLI',
  'ADMIN_ENABLED_BY_CLI',
  'ADMIN_NOTICE_CREATED',
  'ADMIN_NOTICE_UPDATED',
  'ADMIN_NOTICE_PUBLISHED',
  'ADMIN_NOTICE_ARCHIVED',
  'ADMIN_INQUIRY_VIEWED',
  'ADMIN_INQUIRY_ANSWERED',
  'ADMIN_INQUIRY_STATUS_CHANGED',
  'ADMIN_REPORT_VIEWED',
  'ADMIN_REPORT_REVIEWED',
  'ADMIN_REPORT_DISMISSED',
  'ADMIN_REPORT_RESOLVED',
  'ADMIN_CONTENT_DELETED',
  'ADMIN_USER_SUSPENDED',
  'ADMIN_PHOTO_VIEWED',
  'ADMIN_VIDEO_VIEWED',
  'ADMIN_COMMENT_VIEWED',
  'ADMIN_USER_VIEWED',
  'ADMIN_USER_RENAMED',
  'ADMIN_USER_UNSUSPENDED',
  'ADMIN_USER_DELETED',
  'ADMIN_GROUP_VIEWED',
  'ADMIN_ALBUM_PHOTOS_VIEWED',
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type AdminAuditTargetType =
  | 'ADMIN'
  | 'NOTICE'
  | 'INQUIRY'
  | 'REPORT'
  | 'PHOTO'
  | 'COMMENT'
  | 'USER'
  | 'GROUP'
  | 'ALBUM';
export const ADMIN_AUDIT_METADATA_KEYS = [
  'stage',
  'reason',
  'method',
  'sessionRevoked',
  'revokedSessions',
  'previousStatus',
  'status',
  'action',
  'alsoResolved',
  'effectApplied',
  'reportId',
  'groupId',
  'photoId',
  'commentId',
  'userId',
] as const;
type MetadataKey = (typeof ADMIN_AUDIT_METADATA_KEYS)[number];
export type AdminAuditMetadata = Partial<
  Record<MetadataKey, string | number | boolean>
>;
export interface AdminAuditEntry {
  adminId: string | null;
  action: AdminAuditAction;
  targetType?: AdminAuditTargetType;
  targetId?: string;
  reason?: string;
  metadata?: AdminAuditMetadata;
}
// Enum-like string values only (no free text can slip into metadata).
const SAFE_VALUE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function adminAuditMetadata(
  metadata: AdminAuditMetadata = {}
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!(ADMIN_AUDIT_METADATA_KEYS as readonly string[]).includes(key))
      throw new Error('Unsupported admin audit metadata key');
    const valid = key.endsWith('Id')
      ? typeof value === 'string' && UUID.test(value)
      : typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isSafeInteger(value)) ||
        (typeof value === 'string' && SAFE_VALUE.test(value));
    if (!valid) throw new Error('Unsupported admin audit metadata value');
    result[key] = value;
  }
  return result;
}
export async function writeAdminAudit(
  tx: Prisma.TransactionClient,
  entry: AdminAuditEntry
) {
  return tx.adminAuditLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      reason: entry.reason ?? null,
      metadata: adminAuditMetadata(entry.metadata),
    },
    select: { id: true },
  });
}
