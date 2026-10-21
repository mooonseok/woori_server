// deploy/lightsail/deploy-release.sh (the runner side) against two fake hosts
// over a fake ssh, with a local HTTP server standing in for the public API:
// order, rollbacks, dropped connections (M1/H1), reconcile and fast rollback;
// plus deploy/lightsail/ssh-config.sh input checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  NEW,
  OLD,
  fakeHost,
  imageArchive,
  ref,
  repo,
  type FakeHost,
} from './deploy-harness';

const runner = join(repo, 'deploy/lightsail/deploy-release.sh');
const fakeSsh = join(repo, 'test/fixtures/fake-ssh.mjs');

interface Site {
  api: FakeHost;
  worker: FakeHost;
  run(
    mode: string[],
    env?: NodeJS.ProcessEnv
  ): Promise<{ code: number | null; out: string }>;
  faults(list: object[]): void;
  outputs(): Record<string, string>;
  releaseDir: string;
}

async function site(
  t: TestContext,
  options: { upload?: boolean } = {}
): Promise<Site> {
  const api = fakeHost(t, 'api');
  const worker = fakeHost(t, 'worker');
  const bin = join(api.dir, 'runner-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeSsh}" "$@"\n`
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  const sshConfig = join(api.dir, 'ssh_config');
  writeFileSync(sshConfig, 'Host *\n');
  const faultsFile = join(api.dir, 'faults.json');
  writeFileSync(faultsFile, '[]');
  // The public API: whatever image woori-api runs on the fake API host.
  const server: Server = createServer((req, res) => {
    const docker = api.docker();
    const c = docker.containers['woori-api'];
    const img =
      (c?.status === 'running' && docker.images[c.image as string]) || null;
    const publicReady = (img?.api as { publicReady?: boolean } | undefined)
      ?.publicReady;
    if (!img) {
      res.writeHead(502).end();
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'alive',
          release: img.label || null,
          contract: img.contract ?? undefined,
        })
      );
    } else res.writeHead(publicReady === false ? 503 : 200).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const releaseDir = join(api.dir, 'release');
  mkdirSync(releaseDir);
  const archive = imageArchive(releaseDir, {
    ref: ref(NEW),
    release: NEW.release,
  });
  const file = `woori-server-${NEW.name}-amd64.tar.gz`;
  writeFileSync(join(releaseDir, file), archive.bytes);
  writeFileSync(join(releaseDir, 'SHA256SUMS'), `${archive.sha256}  ${file}\n`);
  writeFileSync(
    join(releaseDir, 'release.json'),
    JSON.stringify({
      schemaVersion: 1,
      image: ref(NEW),
      platform: 'linux/amd64',
      release: NEW.release,
      deployable: true,
      contract: '0.30.0',
      migrations: { count: 23, latest: '20261103000000_profile_avatar' },
      archive: { file, sha256: archive.sha256, bytes: archive.bytes.length },
    })
  );
  if (options.upload)
    for (const h of [api, worker])
      h.setDocker((s) => delete s.images[ref(NEW)]);
  for (const h of [api, worker])
    h.setDocker((s) => {
      s.behavior.db = {
        plan: {
          code: 0,
          stdout: [
            'plan_changes=false',
            `plan_hash=${'d'.repeat(64)}`,
            'plan_mode=ledger',
          ],
        },
      };
    });
  const outputFile = join(api.dir, 'github-output');
  const hosts = {
    'woori-api': {
      script: join(repo, 'deploy/lightsail/woori-deploy.sh'),
      env: api.env,
    },
    'woori-worker': {
      script: join(repo, 'deploy/lightsail/woori-deploy.sh'),
      env: worker.env,
    },
  };
  return {
    api,
    worker,
    releaseDir,
    faults: (list) => writeFileSync(faultsFile, JSON.stringify(list)),
    outputs: () =>
      existsSync(outputFile)
        ? Object.fromEntries(
            readFileSync(outputFile, 'utf8')
              .trim()
              .split('\n')
              .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)])
          )
        : {},
    run(mode, env = {}) {
      const child = spawn('/bin/bash', [runner, ...mode], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_SSH_HOSTS: JSON.stringify(hosts),
          FAKE_SSH_FAULTS: faultsFile,
          DEPLOY_SSH_CONFIG: sshConfig,
          DEPLOY_PUBLIC_URL: `http://127.0.0.1:${port}`,
          DEPLOY_CHECK_ATTEMPTS: '2',
          DEPLOY_CHECK_INTERVAL: '1',
          DEPLOY_RESOLVE_TIMEOUT: '60',
          RELEASE_DIR: releaseDir,
          GITHUB_OUTPUT: outputFile,
          GITHUB_STEP_SUMMARY: join(api.dir, 'summary.md'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      return new Promise((resolve) =>
        child.on('close', (code) => resolve({ code, out }))
      );
    },
  };
}

const running = (h: FakeHost, name: string) =>
  h.docker().containers[name]?.image;

test(
  'prepare uploads and plans; deploy replaces API then worker',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t, { upload: true });
    const prepared = await s.run(['prepare']);
    assert.equal(prepared.code, 0, prepared.out);
    assert.match(
      prepared.out,
      /woori-api: 이미지 전송 중[\s\S]*docker load 완료/
    );
    assert.deepEqual(
      [s.outputs().plan_changes, s.outputs().plan_hash],
      ['false', 'd'.repeat(64)]
    );
    // Nothing changed on the hosts yet.
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    const deployed = await s.run(['deploy']);
    assert.equal(deployed.code, 0, deployed.out);
    assert.equal(running(s.api, 'woori-api'), ref(NEW));
    assert.equal(running(s.worker, 'woori-worker'), ref(NEW));
    assert.match(
      deployed.out,
      /공개 확인: \/healthz release b03ec5b contract 0\.30\.0/
    );
    const reconciled = await s.run(['reconcile'], {
      DEPLOY_OUTCOME: 'success',
      DEPLOY_RELEASE: NEW.release,
      DEPLOY_RELEASE_NAME: NEW.name,
    });
    assert.equal(reconciled.code, 0, reconciled.out);
  }
);

test(
  'deploy refuses without the image (prepare first) and stops at an unapproved DB plan',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t, { upload: true });
    assert.equal((await s.run(['deploy'])).code, 2);
    assert.equal((await s.run(['prepare'])).code, 0);
    s.api.setDocker((st) => {
      st.behavior.db = {
        plan: {
          code: 0,
          stdout: ['plan_changes=true', `plan_hash=${'d'.repeat(64)}`],
        },
        apply: { code: 0, stdout: [`applied_grants=${'e'.repeat(64)}`] },
      };
    });
    const refused = await s.run(['deploy']);
    assert.equal(refused.code, 20, refused.out);
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    writeFileSync(
      join(s.api.dir, 'root/env/migration.env'),
      'MIGRATION_DATABASE_URL=postgresql://x\n'
    );
    const approved = await s.run(['deploy'], {
      DEPLOY_DB_APPROVAL: 'd'.repeat(64),
    });
    assert.equal(approved.code, 0, approved.out);
    assert.equal(running(s.api, 'woori-api'), ref(NEW));
  }
);

test(
  'a failed public check rolls the API back; a failed worker takes the API back too',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t);
    s.api.setDocker((st) => {
      st.images[ref(NEW)].api = { publicReady: false };
    });
    const publicFail = await s.run(['deploy']);
    assert.equal(publicFail.code, 1, publicFail.out);
    assert.match(publicFail.out, /API가 이전 release 3513605 로 돌아왔습니다/);
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    assert.equal(running(s.worker, 'woori-worker'), ref(OLD));

    const w = await site(t);
    w.worker.setDocker((st) => {
      st.images[ref(NEW)].worker = 'crash';
    });
    const workerFail = await w.run(['deploy']);
    assert.equal(workerFail.code, 1, workerFail.out);
    assert.equal(running(w.api, 'woori-api'), ref(OLD));
    assert.equal(running(w.worker, 'woori-worker'), ref(OLD));
  }
);

test(
  'L4: a worker failure takes back an API an earlier attempt already replaced',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t);
    assert.equal(
      s.api.run(['deploy-api', NEW.name, NEW.release, '0.30.0']).status,
      0
    );
    s.worker.setDocker((st) => {
      st.images[ref(NEW)].worker = 'crash';
    });
    const result = await s.run(['deploy']);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /API가 이전 release 3513605 로 돌아왔습니다/);
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    assert.equal(running(s.worker, 'woori-worker'), ref(OLD));
  }
);

test(
  'M1: a dropped connection is resolved from the host job, not treated as failure',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t);
    s.api.setDocker((st) => {
      st.behavior.sleepOn = { 'stop:woori-api': 2 };
    });
    s.faults([{ host: 'woori-api', command: 'deploy-api', when: 'during' }]);
    const dropped = await s.run(['deploy']);
    assert.equal(dropped.code, 0, dropped.out);
    assert.match(dropped.out, /연결이 끊겼거나[\s\S]*결과 코드 0/);
    assert.equal(running(s.api, 'woori-api'), ref(NEW));
    assert.equal(running(s.worker, 'woori-worker'), ref(NEW));
  }
);

test(
  'M1: an unknown DB step outcome stops before the API swap',
  { timeout: 240_000 },
  async (t) => {
    const notStarted = await site(t);
    notStarted.faults([{ host: 'woori-api', command: 'db', when: 'before' }]);
    const a = await notStarted.run(['deploy']);
    assert.equal(a.code, 1, a.out);
    assert.match(a.out, /시작되지 않았습니다/);
    assert.equal(running(notStarted.api, 'woori-api'), ref(OLD));

    const unreachable = await site(t);
    unreachable.faults([{ host: 'woori-api', command: 'db', when: 'down' }]);
    const b = await unreachable.run(['deploy'], {
      DEPLOY_RESOLVE_TIMEOUT: '3',
    });
    assert.equal(b.code, 4, b.out);
    assert.match(b.out, /진행 여부를 확인하기 전에는 API를 교체하지 않습니다/);
    assert.equal(running(unreachable.api, 'woori-api'), ref(OLD));
  }
);

test(
  'reconcile: recovers an interrupted job and keeps API and worker on one commit',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t);
    // The worker host job dies mid-swap (old worker stopped and renamed).
    s.worker.setDocker((st) => {
      st.behavior.killOn = { call: 'run:woori-worker', jobsDir: s.worker.jobs };
    });
    const interrupted = await s.run(['deploy']);
    assert.equal(interrupted.code, 1, interrupted.out);
    // deploy-release already recovered the worker and took the API back.
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    assert.equal(running(s.worker, 'woori-worker'), ref(OLD));

    // A cancelled run that left the API on the new release alone.
    const c = await site(t);
    assert.equal(
      c.api.run(['deploy-api', NEW.name, NEW.release, '0.30.0']).status,
      0
    );
    c.worker.setDocker((st) => {
      st.behavior.killOn = { call: 'run:woori-worker', jobsDir: c.worker.jobs };
    });
    assert.equal(
      c.worker.run(['deploy-worker', NEW.name, NEW.release]).status,
      4
    );
    const fixed = await c.run(['reconcile'], {
      DEPLOY_OUTCOME: 'cancelled',
      DEPLOY_RELEASE: NEW.release,
      DEPLOY_RELEASE_NAME: NEW.name,
    });
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(
      fixed.out,
      /중단된 작업을 복구합니다[\s\S]*API를 이전 release로 되돌립니다/
    );
    assert.equal(running(c.api, 'woori-api'), ref(OLD));
    assert.equal(running(c.worker, 'woori-worker'), ref(OLD));
  }
);

test(
  'rollback-to: a release still on both hosts comes back without build or DB step',
  { timeout: 240_000 },
  async (t) => {
    const s = await site(t);
    assert.equal((await s.run(['deploy'])).code, 0);
    const back = await s.run(['rollback-to', OLD.name, OLD.release]);
    assert.equal(back.code, 0, back.out);
    assert.equal(running(s.api, 'woori-api'), ref(OLD));
    assert.equal(running(s.worker, 'woori-worker'), ref(OLD));
    assert.ok(!(s.api.docker().dbCalls ?? []).some((c) => c.mode === 'apply'));
    assert.equal(
      (await s.run(['rollback-to', '20261001-0000000', '0'.repeat(40)])).code,
      2
    );
  }
);

test(
  'ssh-config: only well-formed hosts, ports, users, key lines and keys reach ssh_config',
  { timeout: 240_000 },
  (t) => {
    const dir = fakeHost(t, 'api').dir;
    const key = join(dir, 'k');
    assert.equal(
      spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
        .status,
      0
    );
    const pub = readFileSync(`${key}.pub`, 'utf8')
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const good = {
      SSH_KEY: readFileSync(key, 'utf8'),
      KNOWN_HOSTS: `api.woori.example ${pub}\n172.26.1.167 ${pub}\n`,
      API_HOST: 'api.woori.example',
      WORKER_HOST: '172.26.1.167',
    };
    const run = (env: Record<string, string>) =>
      spawnSync(
        '/bin/bash',
        [join(repo, 'deploy/lightsail/ssh-config.sh'), join(dir, 'ssh')],
        {
          env: { PATH: process.env.PATH, ...env },
          encoding: 'utf8',
        }
      );
    const ok = run(good);
    assert.equal(ok.status, 0, ok.stderr);
    const config = readFileSync(ok.stdout.trim(), 'utf8');
    assert.match(
      config,
      /HostName 172\.26\.1\.167\n  User woori-deploy\n  ProxyJump woori-api/
    );
    assert.doesNotMatch(ok.stdout + ok.stderr, /PRIVATE|ssh-ed25519/);
    for (const [label, change] of [
      [
        'host with an option',
        { API_HOST: 'api.woori.example\n  ProxyCommand x' },
      ],
      ['host with a space', { WORKER_HOST: '172.26.1.167 -oProxyCommand=x' }],
      ['bad port', { API_PORT: '22 x' }],
      ['bad user', { SSH_USER: 'root;x' }],
      [
        'marker line',
        { KNOWN_HOSTS: `@cert-authority * ${pub}\n172.26.1.167 ${pub}` },
      ],
      ['missing worker key', { KNOWN_HOSTS: `api.woori.example ${pub}` }],
      ['not a key', { SSH_KEY: 'not a key' }],
    ] as const) {
      const result = run({ ...good, ...change });
      assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    }
  }
);

test(
  'terminal db command never replaces API or worker',
  { timeout: 120_000 },
  async (t) => {
    const s = await site(t);
    const beforeApi = running(s.api, 'woori-api');
    const beforeWorker = running(s.worker, 'woori-worker');
    const result = await s.run(['db'], { DEPLOY_DB_APPROVAL: 'd'.repeat(64) });
    assert.equal(result.code, 0, result.out);
    assert.equal(running(s.api, 'woori-api'), beforeApi);
    assert.equal(running(s.worker, 'woori-worker'), beforeWorker);
    assert.doesNotMatch(result.out, /API 교체 완료|워커 교체 완료/);
  }
);

test('terminal db rejects missing approval without replacing services', async (t) => {
  const s = await site(t);
  const before = running(s.api, 'woori-api');
  const result = await s.run(['db']);
  assert.equal(result.code, 2, result.out);
  assert.equal(running(s.api, 'woori-api'), before);
});
