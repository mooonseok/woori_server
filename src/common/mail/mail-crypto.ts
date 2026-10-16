import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface MailPayload {
  to: string;
  token?: string;
  username?: string;
}
// v1.<iv>.<tag>.<ciphertext> (base64url). The row id is authenticated data, so
// a payload copied to another row does not decrypt.
export function encryptMailPayload(
  payload: MailPayload,
  key: Buffer,
  mailId: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`woori-mail:${mailId}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}
export function decryptMailPayload(
  value: string,
  key: Buffer,
  mailId: string
): MailPayload {
  const [version, iv, tag, ciphertext, ...rest] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || rest.length)
    throw new Error('Unsupported mail payload');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64url')
  );
  decipher.setAAD(Buffer.from(`woori-mail:${mailId}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plain) as MailPayload;
  if (typeof parsed?.to !== 'string') throw new Error('Invalid mail payload');
  return parsed;
}
