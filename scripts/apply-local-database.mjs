import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
process.loadEnvFile('.env');
const owner = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
const runtime = new URL(process.env.DATABASE_URL ?? '');
for (const url of [owner,runtime]) {
  if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/woori_dev') throw new Error('Only the isolated woori_dev local database may be initialized by this script.');
}
if (runtime.username !== 'woori_api' || owner.username !== 'postgres') throw new Error('Unexpected database roles');
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','migrate','deploy'], {stdio:'inherit',env:process.env});
if (result.status !== 0) process.exit(result.status ?? 1);
const db = new pg.Client({connectionString:owner.toString()});
await db.connect();
try {
  const exists = await db.query("SELECT 1 FROM pg_roles WHERE rolname='woori_api'");
  const secret = decodeURIComponent(runtime.password).replaceAll("'", "''");
  await db.query(`${exists.rowCount ? 'ALTER' : 'CREATE'} ROLE woori_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${secret}'`);
  await db.query(await readFile('prisma/runtime-grants.sql','utf8'));
  console.log('Local migrations and restricted runtime role prepared. No remote database modified.');
} finally {await db.end();}
