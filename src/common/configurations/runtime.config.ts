export interface RuntimeConfig {
  port: number;
  trustedProxyHops: number;
  allowedOrigins: string[];
  databaseUrl?: string;
}
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const trustedProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (![0, 1].includes(trustedProxyHops)) throw new Error('TRUST_PROXY_HOPS must be 0 or 1 after verifying proxy topology');
  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
  }
  return { port, trustedProxyHops, allowedOrigins, databaseUrl: env.DATABASE_URL || undefined };
}
