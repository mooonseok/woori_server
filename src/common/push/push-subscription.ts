import { BadRequestException } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  ECDH,
  randomBytes,
} from 'node:crypto';
import type { PushSubscription } from 'web-push';
export function validateEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const allowed = [
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
    ];
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !allowed.includes(url.hostname) ||
      url.pathname === '/' ||
      endpoint.length > 2048
    )
      throw new Error();
    // Canonical host and no backslash/parser ambiguity. No redirects are followed by transport.
    if (
      !endpoint.startsWith(`https://${url.hostname}/`) ||
      endpoint.includes('\\')
    )
      throw new Error();
  } catch {
    throw new BadRequestException({
      code: 'INVALID_PUSH_ENDPOINT',
      message: '지원하는 브라우저에서 알림을 다시 연결해 주세요.',
    });
  }
}
export function validateSubscription(value: PushSubscription) {
  validateEndpoint(value.endpoint);
  try {
    const key = Buffer.from(value.keys.p256dh, 'base64url');
    const auth = Buffer.from(value.keys.auth, 'base64url');
    if (
      !/^[A-Za-z0-9_-]+={0,2}$/.test(value.keys.p256dh) ||
      !/^[A-Za-z0-9_-]+={0,2}$/.test(value.keys.auth) ||
      key.length !== 65 ||
      auth.length !== 16 ||
      key[0] !== 4
    )
      throw new Error();
    ECDH.convertKey(key, 'prime256v1');
  } catch {
    throw new BadRequestException({
      code: 'INVALID_PUSH_KEYS',
      message: '알림 연결 키가 올바르지 않아요. 다시 연결해 주세요.',
    });
  }
}
export function endpointHash(endpoint: string) {
  return createHash('sha256').update(endpoint).digest('hex');
}
export function encryptSubscription(
  subscription: PushSubscription,
  key: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from('woori:web-push:v1'));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(subscription), 'utf8'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}
export function decryptSubscription(
  value: string,
  key: string
): PushSubscription {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1') throw new Error('Invalid encrypted subscription');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64'),
    Buffer.from(iv, 'base64url')
  );
  cipher.setAAD(Buffer.from('woori:web-push:v1'));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const subscription = JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(ciphertext, 'base64url')),
      cipher.final(),
    ]).toString('utf8')
  ) as PushSubscription;
  validateSubscription(subscription);
  return subscription;
}
