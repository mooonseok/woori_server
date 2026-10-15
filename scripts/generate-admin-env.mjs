import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
// Never print secrets or replace an existing key file. Changing the key makes
// every enrolled authenticator unreadable (recover with pnpm admin:reset-mfa).
const output = '.env.admin.local';
try {
  await writeFile(
    output,
    `ADMIN_TOTP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  console.log(
    'Created .env.admin.local (0600). Copy ADMIN_TOTP_ENCRYPTION_KEY into the API private environment and set ADMIN_WEB_ORIGIN (also listed in CORS_ALLOWED_ORIGINS). Existing .env was not changed.'
  );
} catch (error) {
  console.error(
    error && error.code === 'EEXIST'
      ? '.env.admin.local already exists and was not overwritten. Remove it deliberately only if the key was never deployed.'
      : 'Could not create .env.admin.local.'
  );
  process.exitCode = 1;
}
