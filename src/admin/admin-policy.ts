// Single operator role: every admin has the same permissions. Sensitive actions
// additionally require a recent password + TOTP re-authentication.
const MINUTE = 60 * 1000;
export const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * MINUTE;
export const ADMIN_SESSION_IDLE_MS = 30 * MINUTE;
export const ADMIN_PRE_MFA_SESSION_MS = 10 * MINUTE;
// The sliding idle deadline is written at most once per minute per session.
export const ADMIN_IDLE_REFRESH_INTERVAL_MS = MINUTE;
export const ADMIN_REAUTH_WINDOW_MS = 10 * MINUTE;
export const ADMIN_LOCKOUT_THRESHOLD = 5;
export const ADMIN_LOCKOUT_MS = 15 * MINUTE;
export const ADMIN_SESSION_MFA_FAILURE_LIMIT = 5;
export const ADMIN_RATE_WINDOW_MS = 15 * MINUTE;
export const ADMIN_LOGIN_IP_LIMIT = 30;
export const ADMIN_LOGIN_USERNAME_LIMIT = 10;
export const ADMIN_MFA_IP_LIMIT = 30;
export const ADMIN_PASSWORD_MIN_LENGTH = 16;
export const ADMIN_PASSWORD_MAX_LENGTH = 128;
export const ADMIN_USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
export const ADMIN_DISPLAY_NAME_MAX_LENGTH = 80;

export type AdminAccessLevel = 'public' | 'session' | 'verified';
export type AdminMfaState = 'SETUP_REQUIRED' | 'REQUIRED' | 'VERIFIED';

export interface AdminSessionState {
  mfaVerifiedAt: Date | null;
  reauthAt: Date | null;
}

export function reauthValidUntil(reauthAt: Date | null, now: Date) {
  if (!reauthAt) return null;
  const until = new Date(reauthAt.getTime() + ADMIN_REAUTH_WINDOW_MS);
  return until > now ? until : null;
}

// Route-level decision after a valid admin session was resolved. Pre-MFA
// sessions may only reach routes explicitly marked 'session'.
export function adminAccessError(
  session: AdminSessionState,
  level: AdminAccessLevel,
  requireReauth: boolean,
  now: Date
): 'ADMIN_MFA_REQUIRED' | 'ADMIN_REAUTH_REQUIRED' | null {
  if (level === 'public') return null;
  if (level === 'verified' && !session.mfaVerifiedAt)
    return 'ADMIN_MFA_REQUIRED';
  if (requireReauth) {
    if (!session.mfaVerifiedAt) return 'ADMIN_MFA_REQUIRED';
    if (!reauthValidUntil(session.reauthAt, now))
      return 'ADMIN_REAUTH_REQUIRED';
  }
  return null;
}

// Returns the new idle deadline when the stored one should slide forward, or
// null when no write is needed (pre-MFA sessions never slide).
export function nextIdleExpiry(
  session: {
    mfaVerifiedAt: Date | null;
    idleExpiresAt: Date;
    expiresAt: Date;
  },
  now: Date
): Date | null {
  if (!session.mfaVerifiedAt) return null;
  const target = Math.min(
    now.getTime() + ADMIN_SESSION_IDLE_MS,
    session.expiresAt.getTime()
  );
  if (target - session.idleExpiresAt.getTime() < ADMIN_IDLE_REFRESH_INTERVAL_MS)
    return null;
  return new Date(target);
}

export function isAdminLocked(lockedUntil: Date | null, now: Date) {
  return Boolean(lockedUntil && lockedUntil > now);
}

// Consecutive password/MFA/re-auth failures. An expired lock starts a new
// series; the threshold-th failure locks the account for ADMIN_LOCKOUT_MS.
export function nextFailureState(
  account: { failedLoginCount: number; lockedUntil: Date | null },
  now: Date
) {
  const expired = Boolean(account.lockedUntil && account.lockedUntil <= now);
  const failedLoginCount = (expired ? 0 : account.failedLoginCount) + 1;
  const locked = failedLoginCount >= ADMIN_LOCKOUT_THRESHOLD;
  return {
    failedLoginCount,
    lockedUntil: locked
      ? new Date(now.getTime() + ADMIN_LOCKOUT_MS)
      : expired
        ? null
        : account.lockedUntil,
    locked,
  };
}

export function adminMfaState(
  totpEnabled: boolean,
  mfaVerifiedAt: Date | null
): AdminMfaState {
  if (mfaVerifiedAt) return 'VERIFIED';
  return totpEnabled ? 'REQUIRED' : 'SETUP_REQUIRED';
}
