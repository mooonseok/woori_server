import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, SetMetadata } from '@nestjs/common';
import type { AdminConfig } from '../common/configurations/admin.config';
import { ADMIN_REAUTH_WINDOW_MS } from './admin-policy';
import type { AdminSessionContext } from './dto/admin-session.dto';
export const ADMIN_VIDEO_STREAM = Symbol('admin-video-stream');
export const AdminVideoStream = () => SetMetadata(ADMIN_VIDEO_STREAM, true);
function key(config: AdminConfig) {
  return createHmac('sha256', Buffer.from(config.totpEncryptionKey, 'base64'))
    .update('woori-admin-video-ticket-v1')
    .digest();
}
export function createAdminVideoTicket(
  config: AdminConfig,
  session: AdminSessionContext,
  photoId: string,
  auditId: string,
  now = Date.now()
) {
  const expiresAt = new Date(
    Math.min(
      now + 300_000,
      session.expiresAt.getTime(),
      session.idleExpiresAt.getTime(),
      (session.reauthAt?.getTime() ?? 0) + ADMIN_REAUTH_WINDOW_MS
    )
  );
  const value = Buffer.from(
    JSON.stringify({
      v: 1,
      sessionId: session.sessionId,
      adminId: session.admin.id,
      photoId: photoId.toLowerCase(),
      auditId,
      purpose: 'play',
      exp: expiresAt.getTime(),
    })
  ).toString('base64url');
  return {
    ticket: `${value}.${createHmac('sha256', key(config)).update(value).digest('base64url')}`,
    expiresAt,
  };
}
export function verifyAdminVideoTicket(
  config: AdminConfig,
  session: AdminSessionContext,
  photoId: string,
  ticket: unknown,
  now = Date.now()
) {
  try {
    if (typeof ticket !== 'string' || ticket.length > 1500) throw new Error();
    const [value, signature, extra] = ticket.split('.');
    if (extra || !value || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature))
      throw new Error();
    const expected = createHmac('sha256', key(config)).update(value).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const data = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      data.v !== 1 ||
      data.sessionId !== session.sessionId ||
      data.adminId !== session.admin.id ||
      data.photoId !== photoId.toLowerCase() ||
      data.purpose !== 'play' ||
      !Number.isSafeInteger(data.exp) ||
      data.exp <= now ||
      data.exp > now + 300_000 ||
      typeof data.auditId !== 'string'
    )
      throw new Error();
  } catch {
    throw new ForbiddenException({
      code: 'ADMIN_VIDEO_ACCESS_EXPIRED',
      message:
        '동영상 열람 권한이 만료됐어요. 사유를 입력하고 다시 열어 주세요.',
    });
  }
}
