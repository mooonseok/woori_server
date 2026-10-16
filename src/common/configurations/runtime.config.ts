import { adminConfig, type AdminConfig } from './admin.config';
export interface RuntimeConfig {
  port: number;
  trustedProxyHops: number;
  // Every browser origin the API knows (CORS_ALLOWED_ORIGINS).
  allowedOrigins: string[];
  // Member routes: the allow-list without ADMIN_WEB_ORIGIN, which is reserved
  // for /v1/admin unless it is also the member WEB_ORIGIN.
  memberOrigins: string[];
  databaseUrl?: string;
  admin: AdminConfig | null;
}
export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535');
  const trustedProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (![0, 1].includes(trustedProxyHops))
    throw new Error(
      'TRUST_PROXY_HOPS must be 0 or 1 after verifying proxy topology'
    );
  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        'CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins'
      );
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error(
        'CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins'
      );
  }
  // Validated at startup: a set ADMIN_WEB_ORIGIN must be an exact origin that
  // is listed in CORS_ALLOWED_ORIGINS (one place lists every browser origin).
  const admin = adminConfig(env, allowedOrigins);
  const adminWebOrigin = env.ADMIN_WEB_ORIGIN?.trim() || undefined;
  const webOrigin = env.WEB_ORIGIN?.trim() || undefined;
  return {
    port,
    trustedProxyHops,
    allowedOrigins,
    memberOrigins: allowedOrigins.filter(
      (origin) => origin !== adminWebOrigin || origin === webOrigin
    ),
    databaseUrl: env.DATABASE_URL || undefined,
    admin,
  };
}
