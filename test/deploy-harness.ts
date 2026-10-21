// Shared fixtures for the deployment script tests: a fake Lightsail host (the
// real deploy/lightsail/woori-deploy.sh with a fake docker on PATH, see
// test/fixtures/fake-docker.mjs) and image archives built like `docker save`.
// Nothing here starts containers or reaches the network.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export const repo = join(__dirname, '../..');
export const hostScript = join(repo, 'deploy/lightsail/woori-deploy.sh');
const fakeDocker = join(repo, 'test/fixtures/fake-docker.mjs');

export const OLD = {
  name: '20261020-3513605',
  release: `3513605${'a'.repeat(33)}`,
};
export const NEW = {
  name: '20261021-b03ec5b',
  release: `b03ec5b${'c'.repeat(33)}`,
};
export const ref = (r: { name: string }) => `woori-server:${r.name}`;

export type DockerState = {
  images: Record<string, Record<string, unknown>>;
  containers: Record<string, Record<string, unknown>>;
  networks?: string[];
  behavior: Record<string, unknown>;
  calls?: string[];
  dbCalls?: {
    mode: string;
    args: string[];
    mounts: string[];
    envFiles: string[];
    readable: boolean[];
  }[];
};

export function baseImages() {
  return {
    [ref(OLD)]: {
      id: 'sha256:old',
      arch: 'amd64',
      user: 'node',
      label: OLD.release,
      contract: null,
      worker: 'polling',
    },
    [ref(NEW)]: {
      id: 'sha256:new',
      arch: 'amd64',
      user: 'node',
      label: NEW.release,
      contract: '0.30.0',
      worker: 'polling',
    },
    'caddy:2-alpine': {
      id: 'sha256:caddy',
      arch: 'amd64',
      user: '',
      label: '',
    },
  };
}

const running = (image: string, cmd: string) => ({
  image,
  cmd: ['node', cmd],
  status: 'running',
  restartCount: 0,
  restart: 'unless-stopped',
  startedAt: '2026-10-20T00:00:00Z',
});

export interface FakeHost {
  dir: string;
  conf: string;
  jobs: string;
  backupConf: string;
  env: NodeJS.ProcessEnv;
  run(
    args: string[],
    options?: { input?: Buffer | string; env?: NodeJS.ProcessEnv }
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  ssh(command: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  start(args: string[]): ReturnType<typeof spawn>;
  docker(): DockerState;
  setDocker(change: (state: DockerState) => void): void;
  state(): Record<string, string>;
  lastJob(): string;
}

export function fakeHost(
  t: TestContext,
  role: 'api' | 'worker',
  options: { conf?: Record<string, string>; backup?: string | null } = {}
): FakeHost {
  assert(process.getuid?.() !== 0, 'run the deployment tests as a normal user');
  const dir = mkdtempSync(join(tmpdir(), `woori-deploy-${role}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  for (const sub of [
    'bin',
    'root/env',
    'root/certs',
    'root/images',
    'state',
    'etc',
  ])
    mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`
  );
  writeFileSync(join(bin, 'flock'), '#!/bin/sh\n[ -z "$FAKE_FLOCK_BUSY" ]\n');
  for (const tool of ['docker', 'flock']) chmodSync(join(bin, tool), 0o755);
  writeFileSync(join(dir, 'root/env/common.env'), 'NODE_ENV=production\n');
  writeFileSync(join(dir, 'root/env/api.env'), 'TRUST_PROXY_HOPS=1\n');
  writeFileSync(join(dir, 'root/certs/supabase-ca.crt'), 'test CA\n');
  const backupConf = join(dir, 'etc/r2-backup.conf');
  if (options.backup !== null)
    writeFileSync(
      backupConf,
      `# r2 backup\nWOORI_IMAGE=${options.backup ?? ref(OLD)}\n`
    );
  const settings: Record<string, string> = {
    WOORI_ROLE: role,
    WOORI_ROOT: join(dir, 'root'),
    WOORI_STATE_DIR: join(dir, 'state'),
    WOORI_LOCK_FILE: join(dir, 'state/lock'),
    WOORI_BACKUP_CONF: backupConf,
    WOORI_DETACH: 'background',
    WOORI_MIN_FREE_MB: '1',
    WOORI_HEALTH_TIMEOUT: '2',
    WOORI_SETTLE_SECONDS: '0',
    WOORI_WORKER_START_TIMEOUT: '2',
    ...options.conf,
  };
  const conf = join(dir, 'deploy.conf');
  writeFileSync(
    conf,
    Object.entries(settings)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  );
  const statePath = join(dir, 'docker.json');
  const initial: DockerState = {
    images: baseImages(),
    containers:
      role === 'api'
        ? {
            'woori-api': running(ref(OLD), 'dist/src/main.js'),
            'woori-caddy': {
              ...running('caddy:2-alpine', 'caddy'),
              cmd: ['caddy', 'run'],
            },
          }
        : { 'woori-worker': running(ref(OLD), 'dist/src/worker/main.js') },
    networks: ['woori'],
    behavior: {},
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    WOORI_DEPLOY_CONF: conf,
    FAKE_DOCKER_STATE: statePath,
    SUDO_USER: '',
  };
  const jobs = join(dir, 'state/jobs');
  const host: FakeHost = {
    dir,
    conf,
    jobs,
    backupConf,
    env,
    run(args, opts = {}) {
      const result = spawnSync('/bin/bash', [hostScript, ...args], {
        env: { ...env, ...opts.env },
        input: opts.input,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    ssh(command) {
      return host.run(['ssh'], { env: { SSH_ORIGINAL_COMMAND: command } });
    },
    start(args) {
      // Its own process group, like an SSH session that sshd hangs up on.
      return spawn('/bin/bash', [hostScript, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    },
    docker: () => JSON.parse(readFileSync(statePath, 'utf8')),
    setDocker(change) {
      const state = host.docker();
      change(state);
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    },
    state() {
      const file = join(dir, `state/${role}.state`);
      if (!existsSync(file)) return {};
      return Object.fromEntries(
        readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => [
            line.split('=')[0],
            line.slice(line.indexOf('=') + 1),
          ])
      );
    },
    lastJob: () => readFileSync(join(jobs, 'last'), 'utf8').trim(),
  };
  return host;
}

function assert(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

// Waits until a job's result file exists (the job keeps running detached).
export async function jobResult(host: FakeHost, id: string, seconds = 60) {
  for (let i = 0; i < seconds * 10; i++) {
    const file = join(host.jobs, `${id}.rc`);
    if (existsSync(file)) return Number(readFileSync(file, 'utf8').trim());
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} did not finish`);
}

export const latestJob = (host: FakeHost) =>
  readdirSync(host.jobs)
    .filter((f) => f.endsWith('.cmd'))
    .sort()
    .at(-1)!
    .slice(0, -4);

// An archive shaped like `docker save` output (OCI layout + manifest.json),
// written with python's tarfile so it is the same on macOS and Linux.
export function imageArchive(
  dir: string,
  options: {
    ref: string;
    release: string;
    repoTags?: string[];
    index?: unknown;
    extraFiles?: Record<string, string>;
    rawIndex?: string;
  }
) {
  const config = JSON.stringify({
    architecture: 'amd64',
    config: {
      User: 'node',
      Labels: { 'org.opencontainers.image.revision': options.release },
    },
  });
  const digest = createHash('sha256').update(config).digest('hex');
  const files: Record<string, string> = {
    'oci-layout': '{"imageLayoutVersion":"1.0.0"}',
    [`blobs/sha256/${digest}`]: config,
    'manifest.json': JSON.stringify([
      {
        Config: `blobs/sha256/${digest}`,
        RepoTags: options.repoTags ?? [options.ref],
        Layers: [],
      },
    ]),
    'index.json':
      options.rawIndex ??
      JSON.stringify(
        options.index ?? {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [
            {
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              digest: `sha256:${digest}`,
              size: config.length,
              annotations: {
                'io.containerd.image.name': `docker.io/library/${options.ref}`,
                'org.opencontainers.image.ref.name': options.ref.split(':')[1],
              },
            },
          ],
        }
      ),
    ...options.extraFiles,
  };
  const spec = join(dir, `archive-${Date.now()}-${Math.random()}.json`);
  writeFileSync(spec, JSON.stringify(files));
  const archive = join(
    dir,
    `archive-${createHash('sha256').update(spec).digest('hex').slice(0, 8)}.tar.gz`
  );
  const py = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import io,json,sys,tarfile\nfiles=json.load(open(sys.argv[1]))\nwith tarfile.open(sys.argv[2],"w:gz") as t:\n  for name,text in files.items():\n    data=text.encode()\n    info=tarfile.TarInfo(name)\n    info.size=len(data)\n    t.addfile(info,io.BytesIO(data))',
      spec,
      archive,
    ],
    { encoding: 'utf8' }
  );
  if (py.status !== 0) throw new Error(py.stderr);
  const bytes = readFileSync(archive);
  return {
    archive,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
