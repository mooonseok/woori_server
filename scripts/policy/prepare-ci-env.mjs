import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('CI-only bootstrap');
if (existsSync('.env') || existsSync('.env.local-db')) throw new Error('Existing environment preserved');
const owner = randomBytes(24).toString('hex');
const runtime = randomBytes(24).toString('hex');
writeFileSync('.env.local-db', `WOORI_LOCAL_POSTGRES_PASSWORD=${owner}\n`, { mode: 0o600, flag: 'wx' });
writeFileSync('.env', `DATABASE_URL=postgresql://woori_api:${runtime}@127.0.0.1:55439/woori_dev\nMIGRATION_DATABASE_URL=postgresql://postgres:${owner}@127.0.0.1:55439/woori_dev\n`, { mode: 0o600, flag: 'wx' });
