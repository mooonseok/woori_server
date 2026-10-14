import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
export const sessionCookieName = () =>
  process.env.NODE_ENV === 'production'
    ? '__Host-woori_session'
    : 'woori_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const createToken = () => randomBytes(32).toString('base64url');
export function sessionToken(request: Request): string | undefined {
  const entries = (request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim().split('='));
  const values = entries.filter(([name]) => name === sessionCookieName());
  // Reject duplicate cookies rather than accepting ambiguous subdomain input.
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0][1] ?? ''))
    return undefined;
  return values[0][1];
}
export function setSessionCookie(response: Response, token: string) {
  response.cookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}
export function clearSessionCookie(response: Response) {
  response.clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}
