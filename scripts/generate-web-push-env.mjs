import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import webPush from 'web-push';
// Never print secrets or replace existing keys. Rotation invalidates browser
// subscriptions and encrypted installations, so it requires a separate plan.
const subject = process.argv[2];
let contact;
try {
  contact = new URL(subject);
} catch {
  /* validated below */
}
if (
  !subject ||
  !contact ||
  !['mailto:', 'https:'].includes(contact.protocol) ||
  /[\r\n]/.test(subject) ||
  (contact.protocol === 'mailto:' && !contact.pathname.includes('@'))
) {
  console.error('Usage: pnpm push:keys mailto:your-contact@example.com');
  process.exitCode = 1;
} else {
  const keys = webPush.generateVAPIDKeys();
  const output = '.env.web-push.local';
  await writeFile(
    output,
    `WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}\nWEB_PUSH_VAPID_SUBJECT=${subject}\nPUSH_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  console.log(
    'Created .env.web-push.local (0600). Copy its four values into API/worker private environment settings. Existing .env was not changed.'
  );
}
