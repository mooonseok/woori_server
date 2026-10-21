// IDE terminal: pnpm deploy:db | pnpm deploy:server [--check].
// Always releases the remote develop head, never the current working tree.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import {
  base,
  expand,
  log,
  assert,
  run,
  buildEnv,
  config,
  acquire,
  target,
  current,
  noActions,
  checkout,
  fields,
} from './common.mjs';
import { applyReviewedChecks, allowReviewedChecks } from './manual-db.mjs';
import { findRelease } from './release-cache.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'mooonseok/woori_server';
const [mode, ...args] = process.argv.slice(2);
const setup = () => {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const file = join(base, 'server.json');
  if (!existsSync(file))
    writeFileSync(
      file,
      JSON.stringify(
        {
          apiHost: '54.116.3.5',
          workerHost: '172.26.1.167',
          keyFile: '~/.ssh/woori_actions_deploy',
          knownHostsFile: '~/.ssh/known_hosts',
          migrationEnv: '~/.woori/production/migration.env',
          publicUrl: 'https://api.woori.stream',
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );
  log(
    `설정: ${file} (기존 파일은 보존). IP·키 경로를 확인하세요. 키와 DB 암호는 출력하지 않습니다.`
  );
};
function testDatabase(source) {
  const env = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    const u = new URL(env[key]);
    assert(
      u.hostname === '127.0.0.1' &&
        u.port === '55439' &&
        u.pathname === '/woori_dev',
      '품질 검사는 127.0.0.1:55439/woori_dev 설정만 허용합니다. pnpm dev:db로 준비하세요.'
    );
  }
  writeFileSync(
    join(source, '.env'),
    ['DATABASE_URL', 'MIGRATION_DATABASE_URL']
      .map((k) => `${k}=${JSON.stringify(env[k])}`)
      .join('\n') + '\n',
    { mode: 0o600 }
  );
}
async function main() {
  if (mode === 'setup') return setup();
  if (args.includes('--help')) {
    log(
      'pnpm deploy:setup → 설정 확인 → pnpm deploy:db / pnpm deploy:server. --check는 설정·대상만 조회합니다. DB는 백업 확인 후 터미널 승인이 필요합니다.'
    );
    return;
  }
  assert(
    ['db', 'server'].includes(mode) && args.every((a) => a === '--check'),
    '사용법: pnpm deploy:db|deploy:server [--check|--help]'
  );
  const cfg = config('server');
  const { head, remote } = await target(root, repository);
  await noActions(repository);
  const temp = mkdtempSync(join(tmpdir(), 'woori-ssh-'));
  const unlock = acquire('server');
  let source;
  try {
    const ssh = await run(
      'bash',
      [join(root, 'deploy/lightsail/ssh-config.sh'), join(temp, 'ssh')],
      {
        capture: true,
        env: buildEnv({
          API_HOST: cfg.apiHost,
          WORKER_HOST: cfg.workerHost,
          SSH_KEY: readFileSync(expand(cfg.keyFile), 'utf8'),
          KNOWN_HOSTS: readFileSync(expand(cfg.knownHostsFile), 'utf8'),
        }),
      }
    );
    const sshConfig = ssh.out;
    const env = buildEnv({
      DEPLOY_SSH_CONFIG: sshConfig,
      DEPLOY_PUBLIC_URL: cfg.publicUrl,
      DEPLOY_EXPECT_RELEASE: head,
    });
    for (const host of ['woori-api', 'woori-worker']) {
      const s = await run('ssh', ['-n', '-F', sshConfig, host, 'status'], {
        capture: true,
      });
      assert(
        fields(s.out).role === (host === 'woori-api' ? 'api' : 'worker'),
        '서버 역할 불일치'
      );
      assert(
        fields(s.out).job_state !== 'running',
        '서버에서 다른 배포 작업이 실행 중입니다.'
      );
    }
    log(`대상: ${mode}, origin/develop ${head}, ${cfg.publicUrl}`);
    if (args.includes('--check')) {
      log('설정·SSH 상태 확인 완료. 빌드·DB 변경·배포 없음.');
      return;
    }
    if (mode === 'db')
      assert(
        process.stdin.isTTY,
        'DB 배포는 IDE의 대화형 터미널에서 실행하세요.'
      );
    source = await checkout(root, remote, head);
    testDatabase(source.dir);
    log('격리된 체크아웃에서 품질 검사를 실행합니다 (로컬 개발 DB 필요).');
    await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: source.dir,
    });
    await run('pnpm', ['policy:quality'], { cwd: source.dir });
    rmSync(join(source.dir, '.env'));
    const cached = await findRelease(
      [join(base, 'releases'), expand('~/.woori/releases')],
      head
    );
    const out =
      cached ?? join(base, 'releases', `${mode}-${head}-${Date.now()}`);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    if (cached) {
      log(`기존 릴리스 재사용 (커밋·검증 기록·SHA256 확인): ${cached}`);
    } else {
      log('검증된 linux/amd64 배포 이미지를 빌드합니다.');
      await run(
        process.execPath,
        [
          join(source.dir, 'scripts/release-image.mjs'),
          '--commit',
          head,
          '--out',
          out,
        ],
        { cwd: root }
      );
    }
    const deploymentEnv = { ...env, RELEASE_DIR: out };
    const runner = join(root, 'deploy/lightsail/deploy-release.sh');
    await current(root, head);
    await noActions(repository);
    log('이미지 전송·워커 사전 검사·DB 계획 확인');
    const prepared = await run('bash', [runner, 'prepare'], {
      env: deploymentEnv,
      capture: true,
      allowed: [0, 21],
    });
    console.log(prepared.out);
    if (prepared.err) console.log(prepared.err);
    let plan = fields(prepared.out);
    assert(
      plan.plan_mode === 'ledger',
      '원장을 읽지 못했습니다. ledger.env를 먼저 확인하세요.'
    );
    if (mode === 'db') {
      const report = JSON.parse(
        prepared.out.split('\n').find((l) => l.startsWith('{"db":"plan"'))
      );
      allowReviewedChecks({ manual: report.manual }, report.decision);
      if (plan.plan_changes === 'true') {
        for (const name of report.pending) {
          assert(/^\d{14}_[a-z0-9_]+$/.test(name), 'migration 이름 오류');
          console.log(
            `\n--- ${name} ---\n${readFileSync(join(source.dir, 'prisma/migrations', name, 'migration.sql'), 'utf8')}`
          );
        }
        if (plan.plan_grants_changed === 'true')
          console.log(
            `\n--- runtime-grants.sql ---\n${readFileSync(join(source.dir, 'prisma/runtime-grants.sql'), 'utf8')}`
          );
        log(
          '대상: Supabase 운영 DB. 백업 완료 시각을 확인하세요. 복구 시 이전 앱을 유지하고 추가된 DB 구조는 남깁니다.'
        );
        const prompt = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        let answer;
        try {
          answer = await prompt.question(
            `백업과 위 변경을 확인했다면 APPLY ${head.slice(0, 7)} 입력: `
          );
        } finally {
          prompt.close();
        }
        assert(
          answer === `APPLY ${head.slice(0, 7)}`,
          '취소했습니다. DB·컨테이너 변경 없음.'
        );
        await current(root, head);
        await noActions(repository);
        if (prepared.code === 21)
          await applyReviewedChecks({
            dir: source.dir,
            file: cfg.migrationEnv,
            expectedHash: plan.plan_hash,
            grantsChanged: plan.plan_grants_changed === 'true',
          });
        const fresh = await run(
          'ssh',
          [
            '-n',
            '-F',
            sshConfig,
            'woori-api',
            `db-plan ${JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')).image.split(':')[1]} ${head}`,
          ],
          { capture: true }
        );
        const after = fields(fresh.out);
        if (prepared.code === 0)
          assert(
            after.plan_hash === plan.plan_hash,
            '승인 후 DB 계획이 변경됐습니다. 다시 실행해 검토하세요.'
          );
        else
          assert(
            after.plan_pending === '' &&
              after.plan_manual === '0' &&
              after.image_grants === plan.image_grants,
            '수동 적용 후 예상과 다른 DB 계획입니다.'
          );
        plan = after;
        await run('bash', [runner, 'db'], {
          env: { ...deploymentEnv, DEPLOY_DB_APPROVAL: plan.plan_hash },
        });
      }
      log(
        'DB 배포 완료. API·워커는 교체하지 않았습니다. 다음: pnpm deploy:server'
      );
    } else {
      assert(
        prepared.code === 0 && plan.plan_changes === 'false',
        'DB 변경이 남아 있습니다. 먼저 pnpm deploy:db를 실행하세요. API·워커는 교체하지 않았습니다.'
      );
      let outcome = 'failure';
      try {
        await current(root, head);
        await noActions(repository);
        await run('bash', [runner, 'deploy'], {
          env: { ...deploymentEnv, DEPLOY_DB_APPROVAL: 'none' },
        });
        outcome = 'success';
      } finally {
        const name = JSON.parse(
          readFileSync(join(out, 'release.json'), 'utf8')
        ).image.split(':')[1];
        await run('bash', [runner, 'reconcile'], {
          env: {
            ...deploymentEnv,
            DEPLOY_OUTCOME: outcome,
            DEPLOY_RELEASE: head,
            DEPLOY_RELEASE_NAME: name,
          },
        });
      }
      log(`API·워커 배포 완료: ${head}`);
    }
    log(`릴리스 파일: ${out}`);
  } finally {
    source?.cleanup();
    rmSync(temp, { recursive: true, force: true });
    unlock();
  }
}
main().catch((error) => {
  console.error(`[배포] ${error.message}`);
  process.exitCode = 1;
});
