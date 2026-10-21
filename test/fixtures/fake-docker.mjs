// Test double for the docker CLI used by deploy/lightsail/woori-deploy.sh
// (test/deploy-host.test.ts). State and behaviour live in the JSON file named
// by FAKE_DOCKER_STATE; it never talks to a Docker daemon. Only the commands
// and --format templates the host script uses are understood; anything else
// exits 64 so a new docker call cannot pass the tests unnoticed.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';

const path = process.env.FAKE_DOCKER_STATE;
const load = () => JSON.parse(readFileSync(path, 'utf8'));
const save = (state) => {
  writeFileSync(`${path}.${process.pid}`, JSON.stringify(state, null, 2));
  renameSync(`${path}.${process.pid}`, path);
};
const state = load();
state.calls ??= [];
state.containers ??= {};
state.images ??= {};
state.behavior ??= {};
// Images stay known by ID after losing their tag, as in Docker.
state.blobs ??= {};
for (const img of Object.values(state.images))
  state.blobs[img.id] ??= { ...img };
const args = process.argv.slice(2);
const behavior = state.behavior;
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const out = (text) => process.stdout.write(`${text}\n`);
const finish = (code = 0) => {
  save(state);
  process.exit(code);
};
const sleep = (seconds) =>
  spawnSync('sleep', [String(seconds)], { stdio: 'ignore' });

const key = `${args[0]}:${args.find((a, i) => i > 0 && !a.startsWith('-') && !/^\d+$/.test(a)) ?? ''}`;
state.calls.push(args.join(' '));

// Simulates the deployment job dying (reboot, kill -9) at one docker call.
if (behavior.killOn && key === behavior.killOn.call) {
  const killOn = behavior.killOn;
  delete behavior.killOn;
  save(state);
  // Every unfinished job (a .pid without its .rc) and everything it started.
  const jobs = killOn.jobsDir;
  const pids = readdirSync(jobs)
    .filter(
      (f) => f.endsWith('.pid') && !existsSync(`${jobs}/${f.slice(0, -4)}.rc`)
    )
    .map((f) => Number(readFileSync(`${jobs}/${f}`, 'utf8').trim()));
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
  })
    .stdout.trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const doomed = new Set(pids);
  for (let grew = true; grew;) {
    grew = false;
    for (const [child, parent] of table)
      if (doomed.has(parent) && !doomed.has(child)) {
        doomed.add(child);
        grew = true;
      }
  }
  for (const victim of doomed)
    if (victim !== process.pid)
      try {
        process.kill(victim, 'SIGKILL');
      } catch {}
  process.exit(137);
}
if (behavior.sleepOn?.[key]) {
  save(state); // the call is visible to the test while it waits
  sleep(behavior.sleepOn[key]);
}
if (behavior.fail?.includes(key)) {
  process.stderr.write('fake docker: injected failure (with env-file text)\n');
  finish(1);
}

const image = (ref) => state.images[ref];
const imageOf = (name) => image(state.containers[name]?.image) ?? {};
function render(format, c, img) {
  return format
    .replaceAll('{{.Config.Image}}', c?.image ?? '')
    .replaceAll('{{.State.Status}}', c?.status ?? '')
    .replaceAll('{{.RestartCount}}', String(c?.restartCount ?? 0))
    .replaceAll('{{.State.ExitCode}}', String(c?.exitCode ?? 0))
    .replaceAll(
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      img?.label ?? ''
    )
    .replaceAll('{{.Architecture}}', img?.arch ?? '')
    .replaceAll('{{.Config.User}}', img?.user ?? '')
    .replaceAll('{{.DockerRootDir}}', '');
}
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const start = (name) => {
  const c = state.containers[name];
  const mode = image(c.image)?.worker;
  c.status = mode === 'crash' ? 'restarting' : 'running';
  c.restartCount =
    mode === 'crash' ? (c.restartCount ?? 0) + 1 : (c.restartCount ?? 0);
  c.startedAt = now();
  c.checks = 0;
};

const [command, sub] = args;
if (command === 'container' && sub === 'inspect') {
  const name = args.at(-1);
  const c = state.containers[name];
  if (!c) finish(1);
  out(args[2] === '-f' ? render(args[3], c, imageOf(name)) : JSON.stringify(c));
  finish();
}
if (command === 'image' && sub === 'inspect') {
  const img = image(args.at(-1));
  if (!img) finish(1);
  out(args[2] === '-f' ? render(args[3], null, img) : JSON.stringify(img));
  finish();
}
if (command === 'image' && sub === 'rm') {
  delete state.images[args.at(-1)];
  finish();
}
if (command === 'images') {
  for (const [ref, img] of Object.entries(state.images).sort())
    out(`${ref} ${img.id}`);
  finish();
}
if (command === 'tag') {
  const [, id, ref] = args;
  const source = state.blobs[id];
  if (!source) finish(1);
  state.images[ref] = { ...source };
  finish();
}
if (command === 'info') {
  out('');
  finish();
}
if (command === 'network' && sub === 'inspect') {
  finish((state.networks ?? []).includes(args.at(-1)) ? 0 : 1);
}
if (command === 'ps') {
  for (const [name, c] of Object.entries(state.containers))
    if (c.status === 'running')
      out(`${name}|"docker-entrypoint.sh ${c.cmd.join(' ')}"`);
  finish();
}
if (command === 'rm') {
  delete state.containers[args.at(-1)];
  finish();
}
if (command === 'stop') {
  const c = state.containers[args.at(-1)];
  if (!c) finish(1);
  c.status = 'exited';
  c.exitCode = c.cmd.includes('dist/src/worker/main.js') ? 0 : 143;
  finish();
}
if (command === 'start') {
  if (!state.containers[args.at(-1)]) finish(1);
  start(args.at(-1));
  finish();
}
if (command === 'update') {
  const c = state.containers[args.at(-1)];
  if (!c) finish(1);
  c.restart = flagValue('--restart');
  finish();
}
if (command === 'rename') {
  const [, from, to] = args;
  if (!state.containers[from] || state.containers[to]) finish(1);
  state.containers[to] = state.containers[from];
  delete state.containers[from];
  finish();
}
if (command === 'logs') {
  const name = args.at(-1);
  const c = state.containers[name];
  if (!c) finish(1);
  const since = flagValue('--since') ?? '1970-01-01T00:00:00Z';
  const img = imageOf(name);
  if (img.worker === 'polling' && c.startedAt >= since)
    out(
      JSON.stringify({
        service: 'woori-worker',
        status: 'polling',
        release: img.label || null,
        jobsReady: true,
        videoReady: true,
      })
    );
  finish();
}
if (command === 'exec') {
  // docker exec <container> node -e <API check> <release> <contract> <port>
  const name = args[1];
  const c = state.containers[name];
  if (!c || c.status !== 'running') finish(1);
  const img = imageOf(name);
  const api = img.api ?? {};
  const [release, contract] = args.slice(-3, -1);
  c.checks = (c.checks ?? 0) + 1;
  const served = api.release ?? (img.label || null);
  if ((served ?? 'null') !== release) {
    out('release 불일치');
    finish(2);
  }
  const servedContract =
    api.contract === undefined ? (img.contract ?? null) : api.contract;
  if (contract !== '-' && servedContract !== contract) {
    out(`contract 불일치 (${servedContract ?? '없음'})`);
    finish(2);
  }
  if (api.ready === false || (api.failAfter && c.checks > api.failAfter)) {
    out('readyz 503');
    finish(1);
  }
  out(
    `healthz release ${String(served).slice(0, 7)} contract ${servedContract ?? '-'}, readyz 200`
  );
  finish();
}
if (command === 'load') {
  // Names come from the archive exactly as Docker reads them: manifest.json
  // RepoTags and index.json annotations (JSON-decoded, escapes included).
  const file = flagValue('-i');
  const read = (member) =>
    spawnSync('tar', ['-xzOf', file, member], { encoding: 'utf8' }).stdout;
  const manifest = JSON.parse(read('manifest.json'));
  const index = JSON.parse(read('index.json'));
  const config = JSON.parse(read(manifest[0].Config));
  const id = `sha256:${manifest[0].Config.split('/').at(-1)}`;
  const attrs = {
    id,
    arch: config.architecture,
    user: config.config?.User ?? '',
    label: config.config?.Labels?.['org.opencontainers.image.revision'] ?? '',
    contract: '0.30.0',
    worker: 'polling',
  };
  const names = new Set(manifest[0].RepoTags ?? []);
  for (const entry of index.manifests ?? [])
    for (const [k, v] of Object.entries(entry.annotations ?? {}))
      if (k === 'io.containerd.image.name')
        names.add(v.replace(/^docker\.io\/library\//, ''));
  for (const ref of names) state.images[ref] = { ...attrs };
  for (const [ref, extra] of Object.entries(behavior.extraLoadTags ?? {}))
    state.images[ref] = { ...extra };
  for (const img of Object.values(state.images))
    state.blobs[img.id] ??= { ...img };
  out(`Loaded image: ${[...names].join(', ')}`);
  finish();
}
if (command === 'run') {
  const flags = new Map();
  const mounts = [];
  const envFiles = [];
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (['-d', '--rm', '--init'].includes(a)) flags.set(a, true);
    else if (a === '-v') mounts.push(args[++i]);
    else if (a === '--env-file') envFiles.push(args[++i]);
    else if (a.startsWith('-')) flags.set(a, args[++i]);
    else break;
  }
  const ref = args[i];
  const cmd = args.slice(i + 1);
  const img = image(ref);
  if (!img) finish(125);
  if (flags.get('-d')) {
    const name = flags.get('--name');
    if (state.containers[name]) finish(125);
    state.containers[name] = {
      image: ref,
      cmd,
      restart: flags.get('--restart'),
      network: flags.get('--network') ?? null,
      envFiles,
      mounts,
    };
    start(name);
    out('0123456789ab');
    finish();
  }
  if (cmd.includes('scripts/release-db.mjs')) {
    const mode = cmd[cmd.indexOf('scripts/release-db.mjs') + 1];
    state.dbCalls ??= [];
    state.dbCalls.push({
      mode,
      args: cmd.slice(cmd.indexOf('scripts/release-db.mjs') + 1),
      mounts,
      envFiles,
      // The copied settings file must be readable while the container runs.
      readable: mounts.map((m) => existsSync(m.split(':')[0])),
    });
    const reply = behavior.db?.[mode] ?? { code: 0, stdout: [] };
    for (const line of reply.stdout) out(line);
    finish(reply.code);
  }
  if (cmd.includes('-e')) {
    // worker --check
    if (img.check === 'fail') {
      out('worker videoReady is not true');
      finish(1);
    }
    out('worker --check 통과 (ffmpeg·libx264·AAC·preset·release)');
    finish();
  }
  finish(64);
}
process.stderr.write(`fake docker: unsupported ${args.join(' ')}\n`);
finish(64);
