import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import webPush from 'web-push';
process.loadEnvFile('.env');
const owner = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
const runtime = new URL(process.env.DATABASE_URL ?? '');
for (const url of [owner, runtime]) {
  if (
    url.hostname !== '127.0.0.1' ||
    url.port !== '55439' ||
    url.pathname !== '/woori_dev'
  )
    throw new Error(
      'Integration runner only accepts the isolated local woori_dev connection as its parent.'
    );
}
const dbName = `woori_test_${randomBytes(6).toString('hex')}`;
const db = new pg.Client({ connectionString: owner.toString() });
await db.connect();
let created = false,
  exitCode = 1;
const mail = await mkdtemp(join(tmpdir(), 'woori-test-mail-'));
try {
  await db.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  owner.pathname = runtime.pathname = `/${dbName}`;
  const vapid = webPush.generateVAPIDKeys();
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
    WEB_PUSH_VAPID_SUBJECT: 'mailto:integration@example.test',
    PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WOORI_INTEGRATION_TEST: '1',
    DATABASE_URL: runtime.toString(),
    MIGRATION_DATABASE_URL: owner.toString(),
    WEB_ORIGIN: 'http://localhost:3210',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3210',
    MAIL_MODE: 'file',
    DEV_MAIL_DIR: mail,
  };
  const migrate = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env, stdio: 'inherit' }
  );
  if (migrate.status !== 0) throw new Error('Test database migration failed');
  const testOwner = new pg.Client({ connectionString: owner.toString() });
  await testOwner.connect();
  try {
    await testOwner.query(await readFile('prisma/runtime-grants.sql', 'utf8'));
  } finally {
    await testOwner.end();
  }
  exitCode =
    spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', 'dist/integration/*.test.js'],
      { env, stdio: 'inherit' }
    ).status ?? 1;
} finally {
  if (created) await db.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await db.end();
  await rm(mail, { recursive: true, force: true });
}
process.exitCode = exitCode;
