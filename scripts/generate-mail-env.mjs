import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
// Never print secrets or replace an existing key file. Changing the key makes
// queued (not yet sent) mails unreadable; they fail as payload-unreadable and
// the member requests the mail again.
const output = '.env.mail.local';
try {
  await writeFile(
    output,
    `MAIL_OUTBOX_KEY=${randomBytes(32).toString('base64')}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  console.log(
    'Created .env.mail.local (0600). Copy MAIL_OUTBOX_KEY into BOTH the API and the worker private environments (same value). Existing .env was not changed.'
  );
} catch (error) {
  console.error(
    error && error.code === 'EEXIST'
      ? '.env.mail.local already exists and was not overwritten. Remove it deliberately only if the key was never deployed.'
      : 'Could not create .env.mail.local.'
  );
  process.exitCode = 1;
}
