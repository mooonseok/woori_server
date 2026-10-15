import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
// RFC 6238 TOTP (HMAC-SHA-1, 30 s step, 6 digits, ±1 step) without extra
// dependencies. Secrets are 160-bit random values shown once in base32 and
// stored only as AES-256-GCM ciphertext bound to the admin id.
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = '우리 관리자';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32 without padding.
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}
export function base32Decode(text: string): Buffer {
  const normalized = text.replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]*$/.test(normalized)) throw new Error('Invalid base32');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

export function hotp(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}
export function totpStep(nowMs: number) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}
export function totpCode(secret: Buffer, nowMs: number, digits = TOTP_DIGITS) {
  return hotp(secret, totpStep(nowMs), digits);
}
// Returns the matched time step, or null. A step at or before lastUsedStep is a
// replay and never accepted. Every candidate is compared in constant time.
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: bigint | number | null
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  const floor = lastUsedStep === null ? -Infinity : Number(lastUsedStep);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (
    let step = current - TOTP_WINDOW_STEPS;
    step <= current + TOTP_WINDOW_STEPS;
    step++
  ) {
    const equal = timingSafeEqual(Buffer.from(hotp(secret, step)), given);
    if (equal && step > floor) matched = step;
  }
  return matched;
}
export function generateTotpSecret() {
  return randomBytes(TOTP_SECRET_BYTES);
}
export function otpauthUri(username: string, secret: Buffer) {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  return `otpauth://totp/${issuer}:${encodeURIComponent(username)}?secret=${base32Encode(secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

// AES-256-GCM in the same envelope style as push subscriptions. The admin id
// is authenticated data, so a ciphertext copied to another row fails to open.
const aad = (adminId: string) => Buffer.from(`woori:admin-totp:v1:${adminId}`);
export function encryptTotpSecret(
  secret: Buffer,
  key: string,
  adminId: string
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(aad(adminId));
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function decryptTotpSecret(
  value: string,
  key: string,
  adminId: string
): Buffer {
  const [version, iv, tag, ciphertext, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined)
    throw new Error('Invalid encrypted TOTP secret');
  // A fixed 16-byte tag: GCM would otherwise accept truncated tags.
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64'),
    Buffer.from(iv, 'base64url'),
    { authTagLength: 16 }
  );
  decipher.setAAD(aad(adminId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]);
  if (secret.length !== TOTP_SECRET_BYTES)
    throw new Error('Invalid encrypted TOTP secret');
  return secret;
}
