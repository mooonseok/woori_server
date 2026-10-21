// Advisory DB summary of an automatic deployment, on the GitHub runner before
// the image is built (.github/workflows/deploy.yml). Compares the target commit
// with the release the production /healthz reports as running (passed in; this
// script makes no network call) and lists the migrations it adds, whether
// prisma/runtime-grants.sql changed, and statements outside the automatic
// allowlist (src/common/release/migration-gate.ts). It never blocks and grants
// nothing: the API host computes the real plan from the migration ledger
// (`woori-deploy.sh db-plan`, scripts/release-db.mjs) and the approval is bound
// to that plan's hash. A migration listed here as manual may already have been
// applied by hand; then the host finds nothing pending and the deployment
// continues on its own.
// Reads git only; no DB, secrets or network.
//   node scripts/deploy-plan.mjs --target <sha> --deployed <sha|unknown>
// Prints one JSON line; with GITHUB_OUTPUT/GITHUB_STEP_SUMMARY set it also
// writes db_changes, added, manual and a Korean summary.
// Run `pnpm build` first (the helpers are compiled TypeScript).
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist/src/common/release/migration-gate.js');
if (!existsSync(compiled)) {
  console.error('[deploy-plan] Run `pnpm build` first.');
  process.exit(2);
}
const { isMigrationName, releaseDbChanges } = require(compiled);
// The repository to read: the working directory (a checkout), not this file's.
const repo = process.cwd();

const git = (args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const usage = (message) => {
  console.error(`[deploy-plan] ${message}`);
  process.exit(2);
};

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const [key, value] = [args[i], args[i + 1]];
  if (!['--target', '--deployed'].includes(key) || value === undefined)
    usage('Usage: --target <sha> --deployed <sha|unknown>');
  options[key.slice(2)] = value;
}
const SHA = /^[0-9a-f]{40}$/;
if (!SHA.test(options.target ?? '')) usage('--target must be a full SHA');
if (options.deployed !== 'unknown' && !SHA.test(options.deployed ?? ''))
  usage('--deployed must be a full SHA or unknown');

const hasCommit = (sha) =>
  spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo })
    .status === 0;
const migrationNames = (sha) =>
  git(['ls-tree', '--name-only', `${sha}:prisma/migrations`])
    .split('\n')
    .filter(isMigrationName);
const grantsBlob = (sha) => {
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `${sha}:prisma/runtime-grants.sql`],
    { cwd: repo, encoding: 'utf8' }
  );
  return result.status === 0 ? result.stdout.trim() : null;
};

if (!hasCommit(options.target)) usage('Target commit is not in this clone');
const target = migrationNames(options.target).map((name) => ({
  name,
  sql: git([
    'show',
    `${options.target}:prisma/migrations/${name}/migration.sql`,
  ]),
}));
const baseline =
  options.deployed !== 'unknown' && hasCommit(options.deployed)
    ? options.deployed
    : null;
const plan = releaseDbChanges({
  target,
  deployed: baseline ? migrationNames(baseline) : null,
  grantsChanged: baseline
    ? grantsBlob(baseline) !== grantsBlob(options.target)
    : null,
});

console.log(
  JSON.stringify({
    target: options.target,
    deployed: baseline ?? 'unknown',
    ...plan,
  })
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `db_changes=${plan.dbChanges}`,
      `added=${plan.added.join(',')}`,
      `manual=${plan.manual.length}`,
      '',
    ].join('\n')
  );
const reasonText = {
  'running-release-unknown': '운영 실행 release 확인 불가',
  'migrations-added': '새 migration',
  'runtime-grants-changed': 'prisma/runtime-grants.sql 변경',
};
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### 운영 DB 변경 요약 (참고용, 판정은 API 호스트 계획)',
      '',
      `- 배포 커밋: \`${options.target}\``,
      `- 운영 실행 중: \`${baseline ?? '확인 불가'}\``,
      `- DB 변경: ${plan.dbChanges ? '있음 (승인 필요할 수 있음)' : '없음'}`,
      `- 이유: ${plan.reasons.map((r) => reasonText[r]).join(', ') || '없음'}`,
      `- 추가 migration: ${plan.added.map((n) => `\`${n}\``).join(', ') || '없음'}`,
      `- 자동 적용 불가 문장(수동 절차, 이미 적용했으면 무시): ${
        plan.manual.map((m) => `\`${m.name}\` ${m.kind}`).join('; ') || '없음'
      }`,
      '',
    ].join('\n')
  );
