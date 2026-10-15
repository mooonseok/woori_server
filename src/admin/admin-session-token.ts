import type { Request, Response } from 'express';
// Separate cookie from the member session: a member cookie never authenticates
// an admin request and vice versa. SameSite=Strict because the admin web is
// never entered through cross-site links that need an authenticated landing.
export const adminSessionCookieName = () =>
  process.env.NODE_ENV === 'production'
    ? '__Host-woori_admin_session'
    : 'woori_admin_session';
export function adminSessionToken(request: Request): string | undefined {
  const entries = (request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim().split('='));
  const values = entries.filter(([name]) => name === adminSessionCookieName());
  // Reject duplicate cookies rather than accepting ambiguous subdomain input.
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0][1] ?? ''))
    return undefined;
  return values[0][1];
}
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
});
// Max-Age equals the session's absolute lifetime at the time it is issued.
export function setAdminSessionCookie(
  response: Response,
  token: string,
  expiresAt: Date,
  now = new Date()
) {
  response.cookie(adminSessionCookieName(), token, {
    ...cookieOptions(),
    maxAge: Math.max(0, expiresAt.getTime() - now.getTime()),
  });
}
export function clearAdminSessionCookie(response: Response) {
  response.clearCookie(adminSessionCookieName(), cookieOptions());
}
