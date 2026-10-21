// Production DB step of an automatic deployment. Runs INSIDE the release image
// on the Lightsail API host (deploy/lightsail/woori-deploy.sh `db-plan`/`db`),
// the only place that reaches Supabase. Settings arrive as files mounted
// read-only and loaded with `node --env-file-if-exists` (never `docker
// --env-file`, so `docker inspect` shows no URL):
//   /run/woori/ledger.env     LEDGER_DATABASE_URL, a login role that can only
//                             SELECT the migration ledger (optional, see below)
//   /run/woori/migration.env  MIGRATION_DATABASE_URL, the owner role; mounted
//                             only for `apply`, i.e. after a person approved
//                             this exact plan (deploy job, production-migrations)
// `plan` (read-only) compares this image's prisma/migrations with the ledger
// (src/common/release/migration-gate.ts) and prints the pending set, the
// statements that need the manual procedure and a plan hash: sha256 of the
// pending migrations + the runtime-grants.sql change. `apply --approve <hash>`
// recomputes the plan with the owner connection, refuses (exit 20) unless the
// hash is the approved one, then runs `prisma migrate deploy` (the CLI in the
// image) and re-applies prisma/runtime-grants.sql in one transaction — only
// when its hash differs from the one the host recorded as applied
// (--applied-grants). SETUP.md used to re-apply grants on every deployment;
// re-applying an unchanged file changes nothing, and skipping it keeps the
// owner credential out of deployments without DB changes.
// Exit: 0 ok, 2 usage, 20 approval does not match, 21 pending statements need
// the manual procedure, 22 ledger problem (failed/changed/out-of-order
// migration, missing woori_api role), 1 other error (details on stderr only).
// Locks: lock_timeout 10s (WOORI_LOCK_TIMEOUT, e.g. 5s, 30s or off for the
// Prisma URL only, set in the host's deploy.conf). A migration that must wait
// longer for a table lock (a long API transaction) fails instead of queueing
// every API query on that table behind it for minutes; Prisma then records it
// as failed (exit 22 next time) and it is resolved by hand
// (`prisma migrate resolve --rolled-back`), the statements having rolled back
// with their implicit transaction.
// Without ledger.env the plan cannot see the ledger: every deployment then
// counts as a DB change ("unknown" plan bound to the image's whole migration
// set), needs approval, and uses the owner connection to find what is pending.
// One-time setup of the read-only role (owner, psql, password via \password):
//   CREATE ROLE woori_ledger LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
//   GRANT USAGE ON SCHEMA public TO woori_ledger;
//   GRANT SELECT ON public._prisma_migrations TO woori_ledger;
// (runtime-grants.sql revokes the ledger from PUBLIC and the API roles only,
// so this grant survives it.) The runtime role cannot read the ledger.
// Prints migration names, counts and hashes only; Prisma's output (it names
// the database host) goes to stderr, which the host keeps in its log.
//   node scripts/release-db.mjs plan --applied-grants <hash|none>
//   node scripts/release-db.mjs apply --approve <hash> --applied-grants <hash|none>
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  DB_LEDGER_PROBLEM,
  DB_NEEDS_APPROVAL,
  isMigrationName,
  isPlanHash,
  ledgerDecision,
  ledgerPlan,
  migrationChecksum,
  planHash,
  sha256Hex,
} = require(join(root, 'dist/src/common/release/migration-gate.js'));
const pg = require('pg');

const LOCK_TIMEOUT = process.env.WOORI_LOCK_TIMEOUT || '10s';
if (!/^(?:\d{1,5}(?:ms|s)|off)$/.test(LOCK_TIMEOUT)) {
  console.error(
    '[release-db] WOORI_LOCK_TIMEOUT must be like 10s, 500ms or off'
  );
  process.exit(2);
}
const report = (value) => console.log(JSON.stringify(value));
const usage = (message) => {
  console.error(`[release-db] ${message}`);
  process.exit(2);
};

const [mode, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) {
  const [key, value] = [rest[i], rest[i + 1]];
  if (!['--approve', '--applied-grants'].includes(key) || value === undefined)
    usage(
      'Usage: plan --applied-grants <hash|none> | apply --approve <hash> --applied-grants <hash|none>'
    );
  options[key.slice(2)] = value;
}
const appliedGrants = options['applied-grants'];
if (appliedGrants !== 'none' && !isPlanHash(appliedGrants))
  usage('--applied-grants takes none or a sha256');
if (mode === 'plan') {
  if (options.approve !== undefined) usage('plan takes no --approve');
  // The owner credential is never loaded for a read-only plan.
  if (process.env.MIGRATION_DATABASE_URL)
    usage('plan must run without MIGRATION_DATABASE_URL');
} else if (mode === 'apply') {
  if (!isPlanHash(options.approve)) usage('--approve takes a plan hash');
  if (!process.env.MIGRATION_DATABASE_URL)
    usage('apply needs MIGRATION_DATABASE_URL (migration.env)');
} else usage('Usage: plan | apply');

const migrationsDir = join(root, 'prisma', 'migrations');
const local = readdirSync(migrationsDir)
  .filter(isMigrationName)
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'),
  }));
const grantsSql = readFileSync(
  join(root, 'prisma', 'runtime-grants.sql'),
  'utf8'
);
const imageGrants = sha256Hex(grantsSql);
const grantsChanged = imageGrants !== appliedGrants;
const ledgerMode = process.env.LEDGER_DATABASE_URL ? 'ledger' : 'unknown';
// Without the ledger the approval covers the image's migrations and grants.
const unknownHash = planHash({
  mode: 'unknown',
  migrations: local.map((m) => ({
    name: m.name,
    checksum: migrationChecksum(m.sql),
  })),
  grants: imageGrants,
});

// Session settings are plain SET statements: a session pooler may refuse
// startup options.
async function connect(url, readOnly) {
  const db = new pg.Client({
    connectionString: url,
    application_name: 'woori-release-db',
    connectionTimeoutMillis: 15_000,
  });
  connections.push(db);
  await db.connect();
  if (LOCK_TIMEOUT !== 'off')
    await db.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  if (readOnly)
    await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  return db;
}

async function readLedger(db, url) {
  // Prisma keeps its ledger in the connection's schema (default public).
  let schema = 'public';
  try {
    schema = new URL(url).searchParams.get('schema') || 'public';
  } catch {
    throw new Error('database URL is not a URL');
  }
  const ledger = `${db.escapeIdentifier(schema)}._prisma_migrations`;
  const present = await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [
    ledger,
  ]);
  if (!present.rows[0].ok) return null;
  const rows = await db.query(
    `SELECT migration_name, checksum, finished_at IS NOT NULL AS finished,
       rolled_back_at IS NOT NULL AS rolled_back FROM ${ledger}`
  );
  return ledgerPlan(local, rows.rows);
}

const boundHash = (plan) =>
  planHash({
    mode: 'ledger',
    migrations: plan.pending.map((name, i) => ({
      name,
      checksum: plan.pendingChecksums[i],
    })),
    grants: grantsChanged ? imageGrants : null,
  });

function printPlan(plan, hash, changes, decision) {
  report({
    db: 'plan',
    mode: plan ? 'ledger' : 'unknown',
    applied: plan?.applied ?? null,
    pending: plan?.pending ?? null,
    latest: local.at(-1)?.name ?? null,
    grantsChanged,
    manual: plan?.manual ?? [],
    problems: plan
      ? {
          failed: plan.failed,
          checksumMismatch: plan.checksumMismatch,
          outOfOrder: plan.outOfOrder,
          unknownApplied: plan.unknownApplied,
        }
      : null,
    decision,
  });
  console.log(`plan_mode=${plan ? 'ledger' : 'unknown'}`);
  console.log(`plan_changes=${changes}`);
  console.log(`plan_hash=${hash}`);
  console.log(`plan_pending=${plan ? plan.pending.join(',') : 'unknown'}`);
  console.log(`plan_manual=${plan ? plan.manual.length : 'unknown'}`);
  console.log(`plan_grants_changed=${grantsChanged}`);
  console.log(`image_grants=${imageGrants}`);
}

let code = 1;
const connections = [];
try {
  if (mode === 'plan') {
    if (ledgerMode === 'unknown') {
      printPlan(null, unknownHash, true, {
        code: 0,
        reason: 'ledger not readable',
      });
      code = 0;
    } else {
      const db = await connect(process.env.LEDGER_DATABASE_URL, true);
      const plan = await readLedger(db, process.env.LEDGER_DATABASE_URL);
      if (!plan) {
        report({
          db: 'plan',
          decision: { code: 22, reason: 'no migration ledger' },
        });
        code = DB_LEDGER_PROBLEM;
      } else {
        const decision = ledgerDecision(plan);
        printPlan(
          plan,
          boundHash(plan),
          plan.pending.length > 0 || grantsChanged,
          decision
        );
        code = decision.code;
      }
    }
  } else {
    const url = process.env.MIGRATION_DATABASE_URL;
    const db = await connect(url, false);
    const plan = await readLedger(db, url);
    if (!plan) {
      report({
        db: 'apply',
        decision: { code: 22, reason: 'no migration ledger' },
      });
      code = DB_LEDGER_PROBLEM;
    } else {
      const decision = ledgerDecision(plan);
      const expected = ledgerMode === 'ledger' ? boundHash(plan) : unknownHash;
      printPlan(
        plan,
        expected,
        plan.pending.length > 0 || grantsChanged,
        decision
      );
      if (decision.code !== 0) code = decision.code;
      else if (options.approve !== expected) {
        report({
          db: 'apply',
          decision: {
            code: 20,
            reason: 'approval does not match the current plan',
          },
        });
        code = DB_NEEDS_APPROVAL;
      } else if (
        !(await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'woori_api'"))
          .rowCount
      ) {
        report({
          db: 'apply',
          decision: { code: 22, reason: 'woori_api role missing' },
        });
        code = DB_LEDGER_PROBLEM;
      } else {
        if (plan.pending.length) {
          const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js');
          if (!existsSync(cli)) throw new Error('Prisma CLI missing in image');
          const migrationUrl = new URL(url);
          if (
            LOCK_TIMEOUT !== 'off' &&
            !migrationUrl.searchParams.has('options')
          )
            migrationUrl.searchParams.set(
              'options',
              `-c lock_timeout=${LOCK_TIMEOUT}`
            );
          // Prisma output (it names the database host) goes to stderr only.
          const run = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
            cwd: root,
            stdio: ['ignore', 2, 2],
            env: {
              ...process.env,
              MIGRATION_DATABASE_URL: migrationUrl.toString(),
              CHECKPOINT_DISABLE: '1',
              PRISMA_HIDE_UPDATE_MESSAGE: '1',
            },
          });
          if (run.status !== 0)
            throw new Error(`prisma migrate deploy exit ${run.status}`);
        }
        const after = await readLedger(db, url);
        const check = ledgerDecision(after);
        report({
          db: 'migrated',
          applied: after.applied,
          pending: after.pending,
          decision: check,
        });
        if (check.code !== 0 || after.pending.length) code = DB_LEDGER_PROBLEM;
        else {
          if (grantsChanged) {
            // One simple-protocol query = one implicit transaction: all grants
            // or none, so the running API never sees a half-applied set.
            await db.query(grantsSql);
            report({ db: 'grants', decision: { code: 0, reason: 'applied' } });
          } else
            report({
              db: 'grants',
              decision: { code: 0, reason: 'unchanged' },
            });
          console.log(`applied_grants=${imageGrants}`);
          code = 0;
        }
      }
    }
  }
} catch (error) {
  // pg/Prisma messages can include host names; keep them in stderr.
  console.error(`[release-db] ${error?.message ?? error}`);
  report({ db: 'error', decision: { code: 1, reason: 'see host log' } });
  code = 1;
} finally {
  for (const db of connections) await db.end().catch(() => {});
}
process.exitCode = code;
