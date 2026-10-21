// Explicit terminal-only migration path for reviewed CHECK constraints.
// Automatic host/Actions gates remain unchanged. The caller already displayed
// the plan + SQL and received a backup acknowledgement bound to that release.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, privateEnv, run, buildEnv } from './common.mjs';

export function validateOwner(url) {
  const u = new URL(url);
  assert(
    ['postgres:', 'postgresql:'].includes(u.protocol) && u.password,
    'PostgreSQL 소유자 연결 URL과 비밀번호가 필요합니다.'
  );
  assert(
    u.hostname === 'aws-0-ap-northeast-2.pooler.supabase.com' &&
      u.port === '5432' &&
      u.pathname === '/postgres',
    '운영 Supabase 서울 Session pooler 주소가 아닙니다.'
  );
  assert(
    decodeURIComponent(u.username) === 'postgres.okxdxoqgqejudnpcznpd',
    '운영 DB 소유자 역할이 아닙니다.'
  );
  assert(
    u.searchParams.get('sslmode') === 'verify-full' &&
      u.searchParams.get('sslrootcert') &&
      !u.searchParams.has('uselibpqcompat'),
    'verify-full과 로컬 CA 인증서가 필요합니다.'
  );
  assert(
    !u.searchParams.has('schema') || u.searchParams.get('schema') === 'public',
    'migration 원장 스키마가 다릅니다.'
  );
  return u;
}
export function allowReviewedChecks(plan, decision) {
  assert(
    decision.code === 0 ||
      (decision.code === 21 &&
        plan.manual.length > 0 &&
        plan.manual.every(
          (s) => s.kind === 'alter table: add constraint check'
        )),
    'CHECK 제약조건 외의 수동 SQL 또는 원장 오류입니다. 별도 DB 검토가 필요합니다.'
  );
}
export async function applyReviewedChecks({
  dir,
  file,
  expectedHash,
  grantsChanged,
}) {
  const require = createRequire(join(dir, 'package.json'));
  const { Client } = require('pg');
  const {
    ledgerPlan,
    ledgerDecision,
    planHash,
    migrationChecksum,
    isMigrationName,
    sha256Hex,
  } = require(join(dir, 'dist/src/common/release/migration-gate.js'));
  const url = validateOwner(privateEnv(file).MIGRATION_DATABASE_URL);
  const local = readdirSync(join(dir, 'prisma/migrations'))
    .filter(isMigrationName)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(
        join(dir, 'prisma/migrations', name, 'migration.sql'),
        'utf8'
      ),
    }));
  const db = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 15000,
  });
  try {
    await db.connect();
    assert(
      db.connection.stream.encrypted && db.connection.stream.authorized,
      'TLS 인증서 검증 실패'
    );
    await db.query('BEGIN READ ONLY');
    await db.query("SET LOCAL statement_timeout = '15s'");
    const rows = await db.query(
      'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations'
    );
    const plan = ledgerPlan(local, rows.rows);
    const decision = ledgerDecision(plan);
    allowReviewedChecks(plan, decision);
    const hash = planHash({
      mode: 'ledger',
      migrations: local
        .filter((m) => plan.pending.includes(m.name))
        .map((m) => ({ name: m.name, checksum: migrationChecksum(m.sql) })),
      grants: grantsChanged
        ? sha256Hex(
            readFileSync(join(dir, 'prisma/runtime-grants.sql'), 'utf8')
          )
        : null,
    });
    assert(
      hash === expectedHash,
      '승인 후 DB 계획이 달라졌습니다. 다시 확인하세요.'
    );
    await db.query('COMMIT');
    if (!plan.pending.length) return;
    // Keep the verified Session pooler URL unchanged: Supavisor can reject
    // injected PostgreSQL startup options. Prisma retains its migration lock.
    await run(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      {
        cwd: dir,
        env: buildEnv({
          MIGRATION_DATABASE_URL: url.toString(),
          CHECKPOINT_DISABLE: '1',
          PRISMA_HIDE_UPDATE_MESSAGE: '1',
        }),
      }
    );
    const after = ledgerPlan(
      local,
      (
        await db.query(
          'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations'
        )
      ).rows
    );
    assert(
      ledgerDecision(after).code === 0 && after.pending.length === 0,
      '적용 후 원장 검증 실패. 재시도 전에 상태를 확인하세요.'
    );
    console.log(
      '[DB] migration 적용 및 원장 확인 완료. 서버의 권한 적용을 이어갑니다.'
    );
  } catch (error) {
    // pg diagnostics may include connection details: expose a code only.
    if (error.code)
      throw new Error(
        `운영 DB 작업 실패 (${error.code}). migration 기록 확인 전 재실행하지 마세요.`
      );
    throw error;
  } finally {
    await db.end().catch(() => {});
  }
}
