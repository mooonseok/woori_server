// deploy/lightsail/woori-deploy.sh against a fake docker: replacement order,
// rollback and recovery paths, the detached job protocol, the archive checks
// and when the owner DB credential is used. Real hosts are not involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  NEW,
  OLD,
  fakeHost,
  imageArchive,
  jobResult,
  latestJob,
  ref,
} from './deploy-harness';

const deployApi = (contract = '0.30.0') => [
  'deploy-api',
  NEW.name,
  NEW.release,
  contract,
];
const names = (host: ReturnType<typeof fakeHost>) =>
  Object.keys(host.docker().containers).sort();
const imageOf = (host: ReturnType<typeof fakeHost>, name: string) =>
  host.docker().containers[name]?.image;

test(
  'forced command: only listed commands with valid arguments run',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    for (const command of [
      'status; id',
      'bash -i',
      'status $(id)',
      'receive ../../etc 1 2',
      'run-job 20261021000000-1-deploy-api deploy-api',
      `deploy-worker ${NEW.name} ${NEW.release}`,
      `deploy-api ${NEW.name} ${OLD.release} 0.30.0`,
      `db ${NEW.name} ${NEW.release} yes`,
      '',
    ]) {
      const result = host.ssh(command);
      assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    }
    const status = host.ssh('status');
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^role=api$/m);
    assert.match(status.stdout, new RegExp(`^release=${OLD.release}$`, 'm'));
    assert.deepEqual(
      host.docker().calls?.filter((c) => !c.startsWith('container inspect')),
      []
    );
  }
);

test(
  'deploy-api: pre-start check, swap, settle; same release again changes nothing',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    const result = host.run(deployApi());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /job=\d{14}-\d+-deploy-api/);
    assert.match(result.stdout, /사전 기동 확인 완료/);
    assert.match(result.stdout, /result=replaced/);
    assert.equal(imageOf(host, 'woori-api'), ref(NEW));
    assert.equal(
      host.docker().containers[`woori-api-${OLD.name}`].status,
      'exited'
    );
    assert.ok(!names(host).includes('woori-api-next'));
    assert.equal(host.state().state_status, 'deployed');
    // The old container was stopped only after the pre-start container passed.
    const calls = host.docker().calls!;
    const runNext = calls.findIndex((c) => c.includes('--name woori-api-next'));
    const stopOld = calls.indexOf('stop -t 30 woori-api');
    assert.ok(runNext >= 0 && stopOld > runNext);
    assert.ok(calls.slice(runNext, stopOld).includes('rm -f woori-api-next'));
    const again = host.run(deployApi());
    assert.equal(again.status, 0);
    assert.match(again.stdout, /result=unchanged/);
  }
);

test(
  'deploy-api: a failing pre-start container never touches the running API',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    host.setDocker((s) => {
      s.images[ref(NEW)].api = { ready: false };
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /사전 기동 확인 실패/);
    assert.equal(imageOf(host, 'woori-api'), ref(OLD));
    assert.equal(host.docker().containers['woori-api'].status, 'running');
    assert.ok(!host.docker().calls!.some((c) => c.startsWith('stop')));
    // A wrong contract fails at once instead of waiting for the timeout.
    host.setDocker((s) => delete s.images[ref(NEW)].api);
    const wrong = host.run(deployApi('9.9.9'));
    assert.equal(wrong.status, 1);
    assert.match(wrong.stdout, /contract 불일치/);
  }
);

test(
  'deploy-api: a failure after the swap restores the previous container',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    // Each container passes its first check and fails from the second one on.
    host.setDocker((s) => {
      s.images[ref(NEW)].api = { failAfter: 1 };
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout + result.stderr, /이전 API 복구됨/);
    assert.equal(imageOf(host, 'woori-api'), ref(OLD));
    assert.equal(host.docker().containers['woori-api'].status, 'running');
    assert.ok(
      names(host).some((n) => n.startsWith(`woori-api-failed-${NEW.name}-`))
    );
    assert.equal(host.state().state_status, 'rolled-back');
  }
);

test(
  'deploy-api: when the restore fails too, exit 3 and state rollback-failed',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    host.setDocker((s) => {
      s.images[ref(NEW)].api = { failAfter: 1 };
      s.behavior.fail = [`rename:woori-api-${OLD.name}`];
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.equal(host.state().state_status, 'rollback-failed');
  }
);

test(
  'deploy-api: a taken previous name gets a time suffix',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    host.setDocker((s) => {
      s.containers[`woori-api-${OLD.name}`] = {
        image: ref(OLD),
        cmd: ['node', 'dist/src/main.js'],
        status: 'exited',
        restartCount: 0,
      };
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(
      names(host).some((n) =>
        new RegExp(`^woori-api-${OLD.name}-\\d{14}$`).test(n)
      )
    );
    assert.equal(
      host.state().state_previous.startsWith(`woori-api-${OLD.name}-`),
      true
    );
  }
);

test(
  'H1: the SSH side may vanish mid-swap; the detached job still finishes',
  { timeout: 180_000 },
  async (t) => {
    const host = fakeHost(t, 'api');
    host.setDocker((s) => {
      s.behavior.sleepOn = { 'stop:woori-api': 2 };
    });
    const follower = host.start(deployApi());
    follower.stdout!.resume();
    // Wait on the job's own log: the follower may print it only later.
    let id = '';
    for (let i = 0; i < 600 && !id; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!existsSync(host.jobs)) continue;
      const job = readdirSync(host.jobs).find((f) => f.endsWith('.log'));
      if (
        job &&
        readFileSync(join(host.jobs, job), 'utf8').includes(
          '사전 기동 확인 완료'
        )
      )
        id = job.slice(0, -4);
    }
    assert.ok(id, 'the job reached the swap');
    // Hang up while the old API is being stopped (the slowest step).
    for (let i = 0; i < 100; i++) {
      if ((host.docker().calls ?? []).includes('stop -t 30 woori-api')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // sshd hangs up on the whole session, then the client side is gone.
    process.kill(-follower.pid!, 'SIGHUP');
    follower.kill('SIGKILL');
    assert.equal(await jobResult(host, id), 0);
    assert.equal(imageOf(host, 'woori-api'), ref(NEW));
    assert.equal(host.state().state_status, 'deployed');
    const report = host.run(['job', id]);
    assert.match(report.stdout, /result=replaced/);
    assert.match(report.stdout, /^job_state=finished$/m);
    assert.match(report.stdout, /^job_rc=0$/m);
  }
);

test(
  'H1: a job killed halfway is recovered to the previous container',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    // Dies right when starting the new API: the old one is stopped and renamed.
    host.setDocker((s) => {
      s.behavior.killOn = { call: 'run:woori-api', jobsDir: host.jobs };
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.match(result.stdout, /결과 없이 끝났습니다/);
    assert.equal(host.state().state_status, 'deploying');
    assert.ok(!names(host).includes('woori-api'));
    assert.match(host.ssh('status').stdout, /^job_state=died$/m);
    const recovered = host.run(['recover']);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(recovered.stdout, /result=recovered/);
    assert.equal(imageOf(host, 'woori-api'), ref(OLD));
    assert.equal(host.docker().containers['woori-api'].status, 'running');
    assert.equal(host.state().state_status, 'rolled-back');
    // Interrupted after the new API started: recovery parks it and restores.
    host.setDocker((s) => {
      s.behavior.killOn = { call: 'exec:woori-api', jobsDir: host.jobs };
    });
    assert.equal(host.run(deployApi()).status, 4);
    // The next deployment recovers first, then deploys.
    const next = host.run(deployApi());
    assert.equal(next.status, 0, next.stdout + next.stderr);
    assert.match(next.stdout, /result=recovered[\s\S]*result=replaced/);
    assert.equal(imageOf(host, 'woori-api'), ref(NEW));
  }
);

test(
  'rollback-api brings back exactly what the last deployment replaced',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    assert.equal(host.run(['rollback-api', NEW.name]).status, 1);
    assert.equal(host.run(deployApi()).status, 0);
    const back = host.run(['rollback-api', NEW.name]);
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.match(back.stdout, /result=rolledback/);
    assert.equal(imageOf(host, 'woori-api'), ref(OLD));
    assert.ok(
      names(host).some((n) => n.startsWith(`woori-api-rolledback-${NEW.name}-`))
    );
    assert.equal(host.run(['rollback-api', NEW.name]).status, 1);
  }
);

test(
  'deploy-worker: stop first, polling log, backup image follows; failures restore both',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'worker');
    const ok = host.run(['deploy-worker', NEW.name, NEW.release]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const calls = host.docker().calls!;
    assert.ok(
      calls.indexOf('stop -t 120 woori-worker') <
        calls.findIndex((c) => c.includes('--name woori-worker '))
    );
    assert.equal(imageOf(host, 'woori-worker'), ref(NEW));
    assert.match(
      readFileSync(host.backupConf, 'utf8'),
      new RegExp(`^WOORI_IMAGE=${ref(NEW)}$`, 'm')
    );
    assert.match(readFileSync(host.backupConf, 'utf8'), /^# r2 backup$/m);
    const back = host.run(['rollback-worker', NEW.name]);
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.equal(imageOf(host, 'woori-worker'), ref(OLD));
    assert.match(
      readFileSync(host.backupConf, 'utf8'),
      new RegExp(`^WOORI_IMAGE=${ref(OLD)}$`, 'm')
    );

    const crash = fakeHost(t, 'worker');
    crash.setDocker((s) => {
      s.images[ref(NEW)].worker = 'crash';
    });
    const failed = crash.run(['deploy-worker', NEW.name, NEW.release]);
    assert.equal(failed.status, 1);
    assert.equal(imageOf(crash, 'woori-worker'), ref(OLD));
    assert.match(
      readFileSync(crash.backupConf, 'utf8'),
      new RegExp(`^WOORI_IMAGE=${ref(OLD)}$`, 'm')
    );
    // Never two workers.
    const two = fakeHost(t, 'worker');
    two.setDocker((s) => {
      s.containers['manual-worker'] = { ...s.containers['woori-worker'] };
    });
    assert.equal(two.run(['deploy-worker', NEW.name, NEW.release]).status, 1);
    assert.ok(!two.docker().calls!.some((c) => c.startsWith('stop')));
  }
);

test(
  'L2: a backup conf that cannot be replaced is left intact',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'worker');
    const dir = join(host.dir, 'etc');
    const before = readFileSync(host.backupConf, 'utf8');
    chmodSync(dir, 0o555);
    let result;
    try {
      result = host.run(['deploy-worker', NEW.name, NEW.release]);
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /R2 백업 설정 갱신 실패/);
    assert.equal(readFileSync(host.backupConf, 'utf8'), before);
  }
);

test(
  'db: the owner credential is mounted only for an approved plan with changes',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    writeFileSync(
      join(host.dir, 'root/env/migration.env'),
      'MIGRATION_DATABASE_URL=postgresql://x\n'
    );
    writeFileSync(
      join(host.dir, 'root/env/ledger.env'),
      'LEDGER_DATABASE_URL=postgresql://y\n'
    );
    const hash = 'd'.repeat(64);
    const plan = (changes: boolean, code = 0) => ({
      code,
      stdout: [
        '{"db":"plan"}',
        `plan_changes=${changes}`,
        `plan_hash=${hash}`,
        'plan_mode=ledger',
      ],
    });
    host.setDocker((s) => {
      s.behavior.db = {
        plan: plan(false),
        apply: { code: 0, stdout: [`applied_grants=${'e'.repeat(64)}`] },
      };
    });
    const none = host.run(['db', NEW.name, NEW.release, 'none']);
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.match(none.stdout, /소유자 연결을 쓰지 않습니다/);
    host.setDocker((s) => {
      s.behavior.db = { ...(s.behavior.db as object), plan: plan(true) };
    });
    assert.equal(host.run(['db', NEW.name, NEW.release, 'none']).status, 20);
    assert.equal(
      host.run(['db', NEW.name, NEW.release, 'f'.repeat(64)]).status,
      20
    );
    const approved = host.run(['db', NEW.name, NEW.release, hash]);
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    assert.equal(
      readFileSync(join(host.dir, 'state/api.grants'), 'utf8').trim(),
      'e'.repeat(64)
    );
    host.setDocker((s) => {
      s.behavior.db = { ...(s.behavior.db as object), plan: plan(true, 21) };
    });
    assert.equal(host.run(['db', NEW.name, NEW.release, hash]).status, 21);
    const calls = host.docker().dbCalls!;
    const uses = (c: (typeof calls)[number], file: string) =>
      c.mounts.some((m) => m.endsWith(`:/run/woori/${file}:ro`));
    assert.deepEqual(
      calls.map((c) => [
        c.mode,
        uses(c, 'migration.env'),
        uses(c, 'ledger.env'),
      ]),
      [
        ['plan', false, true],
        ['plan', false, true],
        ['plan', false, true],
        ['plan', false, true],
        ['apply', true, true],
        ['plan', false, true],
      ]
    );
    // Settings are never passed with docker --env-file; copies exist only while
    // the container runs.
    assert.ok(
      calls.every((c) => c.envFiles.length === 0 && c.readable.every(Boolean))
    );
    assert.deepEqual(
      readdirSync(join(host.dir, 'state')).filter((f) => f.startsWith('run.')),
      []
    );
    assert.deepEqual(calls[4].args.slice(0, 3), ['apply', '--approve', hash]);
  }
);

test(
  'receive: checksum, strict archive tags, and nothing else may change on load',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    const target = {
      name: '20261022-1234567',
      release: `1234567${'e'.repeat(33)}`,
    };
    const targetRef = ref(target);
    const receive = (bytes: Buffer, sum: string) =>
      host.run(['receive', target.name, target.release, sum], { input: bytes });
    const folder = join(host.dir, 'root/images', target.name);

    const bad = imageArchive(host.dir, {
      ref: targetRef,
      release: target.release,
    });
    assert.equal(receive(bad.bytes, 'a'.repeat(64)).status, 1);
    assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], []);

    for (const [label, archive] of [
      [
        'extra RepoTag',
        imageArchive(host.dir, {
          ref: targetRef,
          release: target.release,
          repoTags: [targetRef, 'caddy:2-alpine'],
        }),
      ],
      // An escaped key still names caddy once JSON is decoded.
      [
        'escaped annotation key',
        imageArchive(host.dir, {
          ref: targetRef,
          release: target.release,
          rawIndex:
            '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:00","annotations":{"io.containerd.image.nam\\u0065":"docker.io/library/caddy:2-alpine"}}]}',
        }),
      ],
      [
        'duplicate key',
        imageArchive(host.dir, {
          ref: targetRef,
          release: target.release,
          rawIndex: `{"schemaVersion":2,"manifests":[],"manifests":[{"annotations":{"io.containerd.image.name":"docker.io/library/${targetRef}"}}]}`,
        }),
      ],
      [
        'unexpected file',
        imageArchive(host.dir, {
          ref: targetRef,
          release: target.release,
          extraFiles: { repositories: '{"caddy":{"2-alpine":"x"}}' },
        }),
      ],
    ] as const) {
      const result = receive(archive.bytes, archive.sha256);
      assert.equal(
        result.status,
        1,
        `${label}: ${result.stdout}${result.stderr}`
      );
      assert.match(
        result.stdout + result.stderr,
        /이미지 묶음 검사 실패/,
        label
      );
    }
    assert.equal(host.docker().images['caddy:2-alpine'].id, 'sha256:caddy');
    assert.ok(!host.docker().images[targetRef]);

    // A load that changes another tag anyway is undone.
    const good = imageArchive(host.dir, {
      ref: targetRef,
      release: target.release,
    });
    host.setDocker((s) => {
      s.behavior.extraLoadTags = {
        'caddy:2-alpine': { id: 'sha256:evil', arch: 'amd64', user: '' },
      };
    });
    const sneaky = receive(good.bytes, good.sha256);
    assert.equal(sneaky.status, 1, sneaky.stdout + sneaky.stderr);
    assert.match(sneaky.stdout + sneaky.stderr, /외의 태그를 바꿨습니다/);
    assert.equal(host.docker().images['caddy:2-alpine'].id, 'sha256:caddy');
    assert.ok(!host.docker().images[targetRef]);

    host.setDocker((s) => delete s.behavior.extraLoadTags);
    const loaded = receive(good.bytes, good.sha256);
    assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
    assert.match(loaded.stdout, /docker load 완료/);
    assert.equal(
      host.run(['has-image', target.name, target.release]).status,
      0
    );
    assert.match(
      readFileSync(join(folder, 'SHA256SUMS'), 'utf8'),
      new RegExp(good.sha256)
    );
    // The same archive again reuses the loaded image.
    assert.match(receive(good.bytes, good.sha256).stdout, /이미 로드된 이미지/);
  }
);

test(
  'lock: another deployment on the host stops the command with 75',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    const result = host.run(deployApi(), { env: { FAKE_FLOCK_BUSY: '1' } });
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.equal(imageOf(host, 'woori-api'), ref(OLD));
  }
);

test(
  'docker error text (it can quote env-file lines) stays in the host log',
  { timeout: 180_000 },
  (t) => {
    const host = fakeHost(t, 'api');
    host.setDocker((s) => {
      s.behavior.fail = ['run:woori-api-next'];
    });
    const result = host.run(deployApi());
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /env-file text/);
    assert.match(
      readFileSync(join(host.dir, 'state/logs/docker.log'), 'utf8'),
      /env-file text/
    );
  }
);
