import { createECDH } from 'node:crypto';
export function webPushConfig(env: NodeJS.ProcessEnv = process.env) {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const subject = env.WEB_PUSH_VAPID_SUBJECT;
  const encryptionKey = env.PUSH_ENCRYPTION_KEY;
  if (!publicKey && !privateKey && !subject && !encryptionKey) return null;
  if (!publicKey || !privateKey || !subject || !encryptionKey)
    throw new Error('Web Push requires all VAPID and encryption settings');
  try {
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== publicKey)
      throw new Error();
    if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error();
    const contact = new URL(subject);
    if (!['mailto:', 'https:'].includes(contact.protocol)) throw new Error();
    if (contact.protocol === 'mailto:' && !contact.pathname.includes('@'))
      throw new Error();
  } catch {
    throw new Error('Web Push configuration is invalid (values redacted)');
  }
  return { publicKey, privateKey, subject, encryptionKey };
}
