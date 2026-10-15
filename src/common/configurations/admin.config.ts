export interface AdminConfig {
  webOrigin: string;
  totpEncryptionKey: string;
}
export const ADMIN_ORIGIN_ERROR =
  'ADMIN_WEB_ORIGIN must be an exact HTTP(S) origin listed in CORS_ALLOWED_ORIGINS';
export const ADMIN_KEY_ERROR =
  'ADMIN_TOTP_ENCRYPTION_KEY must be a base64 32-byte key (value redacted)';
// Returns null when the admin API is not configured (both settings are needed);
// the member API keeps working and every admin route answers 503. Values that
// are present but invalid throw so startup fails fast with a redacted message.
export function adminConfig(
  env: NodeJS.ProcessEnv = process.env,
  allowedOrigins?: string[]
): AdminConfig | null {
  const webOrigin = env.ADMIN_WEB_ORIGIN?.trim() || undefined;
  const totpEncryptionKey = env.ADMIN_TOTP_ENCRYPTION_KEY?.trim() || undefined;
  if (webOrigin) {
    let url: URL | undefined;
    try {
      url = new URL(webOrigin);
    } catch {
      /* rejected below */
    }
    const origins =
      allowedOrigins ??
      (env.CORS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    if (
      !url ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== webOrigin ||
      !origins.includes(webOrigin)
    )
      throw new Error(ADMIN_ORIGIN_ERROR);
  }
  if (totpEncryptionKey) {
    if (
      !/^[A-Za-z0-9+/]{43}=$/.test(totpEncryptionKey) ||
      Buffer.from(totpEncryptionKey, 'base64').length !== 32
    )
      throw new Error(ADMIN_KEY_ERROR);
  }
  if (!webOrigin || !totpEncryptionKey) return null;
  return { webOrigin, totpEncryptionKey };
}
