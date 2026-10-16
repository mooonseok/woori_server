import type { CookieOptions, Response } from 'express';
import {
  clearAdminSessionCookie,
  setAdminSessionCookie,
} from '../../admin/admin-session-token';
import {
  clearSessionCookie,
  setSessionCookie,
} from '../../domain/auth/auth-token';
import { mailOutboxKey } from '../mail/mail-config';

export const PRODUCTION_CONFIG_PREFIX = 'Production configuration invalid: ';
type Role = 'api' | 'worker';

function httpsOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url : null;
  } catch {
    return null;
  }
}
function localHost(host: string) {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    host === '0.0.0.0'
  );
}
// "우리 <no-reply@mail.woori.stream>" or a bare address.
function senderDomain(from: string | undefined) {
  const match = /^(?:[^<>]*<)?[^<>@\s]+@([a-z0-9.-]+)>?$/i.exec(
    from?.trim() ?? ''
  );
  return match?.[1].toLowerCase() ?? null;
}

/**
 * NODE_ENV=production rules (W07-4 deploy topology: https web/admin origins on
 * one site, Railway proxy, R2, Resend on a subdomain of the web domain). Returns
 * the names of the settings that are missing or unsafe, never their values.
 */
export function productionConfigProblems(
  env: NodeJS.ProcessEnv,
  role: Role
): string[] {
  const problems: string[] = [];
  const add = (name: string, ok: unknown) => {
    if (!ok) problems.push(name);
  };
  let databaseHost = '';
  try {
    databaseHost = new URL(env.DATABASE_URL ?? '').hostname;
  } catch {
    /* reported below */
  }
  add('DATABASE_URL', databaseHost && !localHost(databaseHost));
  const web = httpsOrigin(env.WEB_ORIGIN?.trim());
  add('WEB_ORIGIN', web && !localHost(web.hostname));
  add('MAIL_MODE', env.MAIL_MODE === 'resend');
  add('RESEND_API_KEY', env.RESEND_API_KEY?.trim());
  // SPF/DKIM/DMARC alignment: the sender is the web domain or a subdomain
  // (mail.woori.stream for woori.stream).
  const sender = senderDomain(env.MAIL_FROM);
  add(
    'MAIL_FROM',
    sender &&
      web &&
      (sender === web.hostname || sender.endsWith(`.${web.hostname}`))
  );
  let mailKey = false;
  try {
    mailKey = Boolean(mailOutboxKey(env));
  } catch {
    /* malformed: reported by name */
  }
  add('MAIL_OUTBOX_KEY', mailKey);
  add('R2_ACCOUNT_ID', /^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID ?? ''));
  add('R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID?.trim());
  add('R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY?.trim());
  add(
    'R2_BUCKET',
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET ?? '')
  );
  if (role === 'api') {
    // Railway terminates TLS at exactly one proxy hop.
    add('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS === '1');
    const admin = httpsOrigin(env.ADMIN_WEB_ORIGIN?.trim());
    add('ADMIN_WEB_ORIGIN', admin && !localHost(admin.hostname));
    add(
      'ADMIN_TOTP_ENCRYPTION_KEY',
      /^[A-Za-z0-9+/]{43}=$/.test(env.ADMIN_TOTP_ENCRYPTION_KEY?.trim() ?? '')
    );
    const origins = (env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    // Exactly {WEB_ORIGIN, ADMIN_WEB_ORIGIN}: credentialed CORS for any
    // other origin (preview, staging, localhost) is a deploy error.
    const expected = web && admin ? new Set([web.origin, admin.origin]) : null;
    add(
      'CORS_ALLOWED_ORIGINS',
      expected &&
        origins.every((origin) => expected.has(origin)) &&
        [...expected].every((origin) => origins.includes(origin))
    );
  }
  return problems;
}

// Runs the real cookie helpers against a recording response: a __Host- cookie
// is only honoured by browsers with Secure, Path=/ and no Domain attribute.
export function sessionCookieProblems(): string[] {
  const written: { name: string; options: CookieOptions }[] = [];
  const response = {
    cookie(name: string, _value: string, options: CookieOptions) {
      written.push({ name, options });
      return response;
    },
    clearCookie(name: string, options: CookieOptions) {
      written.push({ name, options });
      return response;
    },
  } as unknown as Response;
  const hostOnly = () =>
    written
      .splice(0)
      .every(
        ({ name, options }) =>
          name.startsWith('__Host-') &&
          options.secure === true &&
          options.path === '/' &&
          options.domain === undefined
      );
  const problems: string[] = [];
  setSessionCookie(response, 'x');
  clearSessionCookie(response);
  if (!hostOnly()) problems.push('SESSION_COOKIE');
  setAdminSessionCookie(response, 'x', new Date(Date.now() + 60_000));
  clearAdminSessionCookie(response);
  if (!hostOnly()) problems.push('ADMIN_SESSION_COOKIE');
  return problems;
}

export function assertProductionConfig(env: NodeJS.ProcessEnv, role: Role) {
  if (env.NODE_ENV !== 'production') return;
  const problems = productionConfigProblems(env, role);
  // A regression in the cookie helpers fails startup.
  if (role === 'api') problems.push(...sessionCookieProblems());
  if (problems.length)
    throw new Error(`${PRODUCTION_CONFIG_PREFIX}${problems.join(',')}`);
}
