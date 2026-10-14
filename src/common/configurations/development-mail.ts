import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Development mail contains verification tokens; keep it outside the checkout.
export function developmentMailDirectory(): string | undefined {
  if (process.env.NODE_ENV === 'production' || process.env.MAIL_MODE !== 'file')
    return undefined;
  const directory =
    process.env.DEV_MAIL_DIR?.trim() || join(homedir(), '.woori', 'dev-mail');
  if (!isAbsolute(directory)) return undefined;
  const outside = relative(process.cwd(), resolve(directory));
  if (
    outside !== '..' &&
    !outside.startsWith(`..${sep}`) &&
    !isAbsolute(outside)
  )
    return undefined;
  return directory;
}
