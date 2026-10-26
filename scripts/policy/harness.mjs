import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  realpathSync,
  readlinkSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// A local verification dispatcher, not a sandbox for untrusted checkout code.
const common = {
  'policy:check': 'node scripts/policy/check.mjs',
  'policy:test': 'node --test scripts/policy/*.test.mjs',
  'format:check': 'prettier --check .',
};
const allowed = {
  woori_client: {
    ...common,
    lint: 'eslint apps scripts',
    typecheck: 'pnpm -r typecheck',
    test: 'node --test scripts/tests/*.test.mjs && pnpm --filter @woori/web test && pnpm --filter @woori/admin test',
    'check:boundaries': 'node scripts/check-boundaries.mjs',
    build: 'pnpm -r build',
    'test:deploy:local': 'node --test scripts/tests/local-deploy.test.mjs',
  },
  woori_server: {
    ...common,
    build: 'prisma generate && nest build',
    typecheck: 'prisma generate && tsc --noEmit',
    test: 'pnpm build && node --test dist/test/*.test.js && pnpm test:deploy:local',
    'prisma:validate': 'prisma validate',
    'test:integration': 'pnpm build && node scripts/run-integration.mjs',
    'check:worker': 'node dist/src/worker/main.js --check',
    'test:deploy:local': 'node --test scripts/local-deploy/*.test.mjs',
  },
};
const appScripts = {
  build: 'next build',
  typecheck: 'tsc --noEmit',
  test: 'node --experimental-strip-types --test tests/*.test.ts',
};
const requirements = new Set(['local-db', 'ffmpeg', 'no-next-dev']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
const safeName = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);

export function validateProfiles(config, pkg, root) {
  if (
    config?.version !== 1 ||
    config.repository !== pkg.name ||
    !allowed[pkg.name] ||
    !config.profiles ||
    typeof config.profiles !== 'object' ||
    Array.isArray(config.profiles) ||
    !Object.keys(config.profiles).length
  )
    throw new Error('Invalid harness profile configuration.');
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (
      !safeName(name) ||
      typeof profile.description !== 'string' ||
      !profile.description.trim() ||
      !Array.isArray(profile.steps) ||
      !profile.steps.length
    )
      throw new Error('Invalid harness profile.');
    const seen = new Set();
    for (const step of profile.steps) {
      if (
        !safeName(step.id) ||
        seen.has(step.id) ||
        Object.keys(step).some(
          (key) =>
            !['id', 'script', 'workspace', 'args', 'requires'].includes(key)
        ) ||
        (step.args !== undefined &&
          (!Array.isArray(step.args) || step.args.length)) ||
        (step.requires !== undefined &&
          (!Array.isArray(step.requires) ||
            step.requires.some((r) => !requirements.has(r))))
      )
        throw new Error('Invalid or duplicate harness step.');
      seen.add(step.id);
      let scripts = pkg.scripts;
      let expected = allowed[pkg.name][step.script];
      if (step.workspace !== undefined) {
        if (
          pkg.name !== 'woori_client' ||
          !['@woori/admin', '@woori/web'].includes(step.workspace)
        )
          throw new Error('Workspace is not allowed.');
        scripts = json(
          join(root, 'apps', step.workspace.split('/')[1], 'package.json')
        ).scripts;
        expected = appScripts[step.script];
      }
      if (
        !expected ||
        scripts?.[step.script] !== expected ||
        scripts[`pre${step.script}`] ||
        scripts[`post${step.script}`]
      )
        throw new Error(
          'Script is not approved or its definition changed; review the harness allowlist.'
        );
    }
  }
  // Existing root tasks delegate to these package scripts. Validate their definitions too.
  const rootSteps = Object.values(config.profiles)
    .flatMap((profile) => profile.steps)
    .filter((step) => !step.workspace);
  const names = new Set(rootSteps.map((step) => step.script));
  if (pkg.name === 'woori_server') {
    if (names.has('test') || names.has('test:integration')) names.add('build');
    if (names.has('test')) names.add('test:deploy:local');
    for (const name of names)
      if (
        pkg.scripts[name] !== allowed[pkg.name][name] ||
        pkg.scripts[`pre${name}`] ||
        pkg.scripts[`post${name}`]
      )
        throw new Error('Delegated script definition changed.');
  } else {
    for (const task of ['build', 'typecheck', 'test'])
      if (names.has(task)) {
        for (const app of ['web', 'admin']) {
          const scripts = json(join(root, 'apps', app, 'package.json')).scripts;
          if (
            scripts[task] !== appScripts[task] ||
            scripts[`pre${task}`] ||
            scripts[`post${task}`]
          )
            throw new Error('Delegated workspace script changed.');
        }
      }
  }
  return config;
}
function sourceFile(file) {
  return (
    !/(^|\/)(node_modules|\.git|\.next|out|dist|coverage)(\/|$)/.test(file) &&
    !/(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials\.json)$/.test(file) &&
    !/\.(pem|key|p12|pfx|log|tsbuildinfo)$/i.test(file)
  );
}
export function collectSnapshot(root) {
  if (
    realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !==
    realpathSync(root)
  )
    throw new Error('Run from the repository root.');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '-z']);
  const files = [
    ...new Set(
      git(root, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ])
        .split('\0')
        .filter(Boolean)
    ),
  ].sort();
  const hash = createHash('sha256').update(head);
  let sourceCount = 0;
  for (const file of files.filter(sourceFile)) {
    hash.update(file).update('\0');
    try {
      const path = join(root, file),
        stat = lstatSync(path);
      hash.update(String(stat.mode)).update('\0');
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isFile()) hash.update(readFileSync(path));
      else hash.update('[non-file]');
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Cannot fingerprint source files.');
      hash.update('[deleted]');
    }
    hash.update('\0');
    sourceCount++;
  }
  return {
    head,
    dirty: Boolean(status),
    fingerprint: hash.digest('hex'),
    sourceCount,
    environment: {
      filePresent: existsSync(join(root, '.env')),
      valuesRecorded: false,
      valuesFingerprinted: false,
    },
  };
}
function command(step) {
  return [
    'pnpm',
    ...(step.workspace ? ['--filter', step.workspace] : []),
    'run',
    step.script,
  ];
}
function execute(argv, root) {
  // Discard child output: test failures can contain DB URLs or environment secrets.
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    stdio: 'ignore',
    shell: false,
    timeout: 30 * 60 * 1000,
  });
  return {
    status: result.status,
    errorCode: result.error?.code ?? null,
    signal: result.signal ?? null,
  };
}
function localDatabaseAvailable() {
  const script =
    "const s=require('node:net').connect({host:'127.0.0.1',port:55439});s.setTimeout(1500);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)});";
  return (
    spawnSync(process.execPath, ['-e', script], {
      stdio: 'ignore',
      timeout: 2000,
    }).status === 0
  );
}
export function environmentProblems(
  root,
  step = {},
  env = process.env,
  probe = localDatabaseAvailable
) {
  const needed = new Set(step.requires ?? []);
  if (step.script === 'test:integration') needed.add('local-db');
  if (step.script === 'check:worker') needed.add('ffmpeg');
  if (
    step.script === 'policy:check' &&
    spawnSync('python3', ['-c', 'import tomllib'], {
      stdio: 'ignore',
      timeout: 5000,
    }).status !== 0
  )
    return ['Python 3.11+ with tomllib is required for policy checks.'];
  if (step.script === 'build' && existsSync(join(root, 'apps')))
    needed.add('no-next-dev');
  const problems = [];
  if (needed.has('no-next-dev'))
    for (const app of ['web', 'admin'])
      for (const lock of ['.next/dev/lock', '.next/lock'])
        if (existsSync(join(root, 'apps', app, lock)))
          problems.push(
            'Next.js lock exists; inspect the owning process or stale lock before retrying.'
          );
  if (needed.has('ffmpeg'))
    for (const binary of ['ffmpeg', 'ffprobe'])
      if (spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0)
        problems.push(`${binary} is unavailable.`);
  if (needed.has('local-db')) {
    let values = {};
    try {
      values = parseEnv(readFileSync(join(root, '.env'), 'utf8'));
    } catch {
      /* Presence only. */
    }
    for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
      try {
        // loadEnvFile preserves existing process values, so validate the effective URL.
        const url = new URL(env[name] ?? values[name]);
        if (
          !['postgres:', 'postgresql:'].includes(url.protocol) ||
          url.hostname !== '127.0.0.1' ||
          url.port !== '55439' ||
          url.pathname !== '/woori_dev' ||
          [...url.searchParams.keys()].some((key) => !['schema'].includes(key))
        )
          throw new Error();
      } catch {
        problems.push(`${name} must point to the isolated local test parent.`);
      }
    }
    if (!existsSync(join(root, '.env')))
      problems.push('Local integration requires .env.');
    if (!problems.length && !probe())
      problems.push(
        'The isolated local PostgreSQL port is unavailable; start the approved local service separately.'
      );
  }
  return problems;
}
function preflight(root, pkg) {
  const problems = [];
  if (
    process.versions.node !== readFileSync(join(root, '.nvmrc'), 'utf8').trim()
  )
    problems.push('Node version differs from .nvmrc; run nvm use.');
  const version = spawnSync('pnpm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (
    version.status !== 0 ||
    `pnpm@${version.stdout.trim()}` !== pkg.packageManager
  )
    problems.push('pnpm version differs from packageManager.');
  if (!existsSync(join(root, 'node_modules')))
    problems.push(
      'node_modules is missing; dependency installation is a separate action.'
    );
  return problems;
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Report directory must be private and owned by this user.');
}
export function parseArguments(argv) {
  const options = { mode: argv[0] };
  if (!['check', 'verify'].includes(options.mode))
    throw new Error(
      'Use harness check or verify --profile NAME [--dry-run] [--retry-reason TEXT].'
    );
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run' && options.mode === 'verify' && !options.dryRun)
      options.dryRun = true;
    else if (
      ['--profile', '--retry-reason'].includes(arg) &&
      options.mode === 'verify'
    ) {
      const key = arg === '--profile' ? 'profile' : 'retryReason';
      if (options[key] || !argv[index + 1] || argv[index + 1].startsWith('--'))
        throw new Error('Missing or duplicate option.');
      options[key] = argv[++index].trim();
      if (!options[key]) throw new Error('Empty option.');
    } else throw new Error('Unknown harness option.');
  }
  if (options.mode === 'verify' && !safeName(options.profile))
    throw new Error('A valid --profile is required.');
  return options;
}
export function runHarness(root, options, dependencies = {}) {
  const pkg = json(join(root, 'package.json'));
  const config = validateProfiles(
    json(join(root, 'scripts/policy/verification-profiles.json')),
    pkg,
    root
  );
  if (options.mode === 'verify' && !config.profiles[options.profile])
    throw new Error('Unknown profile.');
  const steps =
    options.mode === 'verify' ? config.profiles[options.profile].steps : [];
  if (options.dryRun)
    return {
      status: 'not-run',
      dryRun: true,
      profile: options.profile,
      steps: steps.map((s) => ({
        id: s.id,
        command: command(s),
        requires: s.requires ?? [],
      })),
    };
  const snapshot = collectSnapshot(root);
  const problems = (dependencies.preflight ?? preflight)(root, pkg);
  const missing = new Map(
    steps.map((step) => [
      step.id,
      (dependencies.environmentProblems ?? environmentProblems)(root, step),
    ])
  );
  for (const reasons of missing.values()) problems.push(...reasons);
  const report = {
    schemaVersion: 1,
    repository: pkg.name,
    profile: options.profile ?? null,
    startedAt: new Date().toISOString(),
    snapshot,
    status: 'pass',
    problems: [...new Set(problems)],
    steps: [],
  };
  if (options.mode === 'check') {
    report.status = problems.length ? 'blocked' : 'pass';
    return report;
  }
  const storage =
    dependencies.storage ??
    join(tmpdir(), 'woori-harness', digest(resolve(root)).slice(0, 20));
  if (
    resolve(storage) === resolve(root) ||
    resolve(storage).startsWith(`${resolve(root)}/`)
  )
    throw new Error('Evidence must be stored outside the repository.');
  let ancestor = resolve(storage);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const destination = resolve(
    realpathSync(ancestor),
    relative(ancestor, resolve(storage))
  );
  const repository = realpathSync(root);
  if (destination === repository || destination.startsWith(`${repository}/`))
    throw new Error('Evidence must not resolve inside the repository.');
  privateDirectory(storage);
  const realStorage = realpathSync(storage),
    realRoot = realpathSync(root);
  if (realStorage === realRoot || realStorage.startsWith(`${realRoot}/`))
    throw new Error('Evidence must not resolve inside the repository.');
  const lock = join(storage, 'running.lock');
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx', 0o600);
  } catch {
    throw new Error(
      'Another run or stale lock exists; inspect the private report directory before retrying.'
    );
  }
  try {
    const statePath = join(storage, 'failures.json');
    let state = {};
    if (existsSync(statePath)) {
      const stat = lstatSync(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new Error('Unsafe failure state.');
      state = json(statePath);
    }
    const key = digest(`${options.profile}:${snapshot.fingerprint}`),
      prior = state[key];
    if (prior?.count >= 2 && !options.retryReason)
      report.problems.push(
        'The same step and exit status failed twice. Analyze cause and attempts, then use --retry-reason with the next hypothesis.'
      );
    let stopped = report.problems.length > 0;
    report.status = stopped ? 'blocked' : 'pass';
    for (const step of steps) {
      const entry = { id: step.id, command: command(step), status: 'not-run' };
      report.steps.push(entry);
      if (missing.get(step.id).length) {
        entry.status = 'blocked';
        entry.reasons = missing.get(step.id);
      }
      if (stopped) continue;
      dependencies.onStep?.({ id: entry.id, status: 'running' });
      const result = (dependencies.execute ?? execute)(entry.command, root);
      entry.exitCode = Number.isInteger(result.status) ? result.status : null;
      entry.status =
        result.status === 0 ? 'pass' : result.errorCode ? 'blocked' : 'fail';
      dependencies.onStep?.({ id: entry.id, status: entry.status });
      if (entry.status !== 'pass') {
        entry.classification =
          entry.status === 'blocked' ? 'environment' : 'unknown';
        entry.diagnostic =
          'Raw output omitted to protect secrets. Reproduce locally and inspect the redacted error; compare the baseline before classifying a regression.';
        report.status = entry.status;
        stopped = true;
        if (entry.status === 'fail') {
          const failure = digest(
              `${entry.id}:${entry.exitCode}:${result.signal ?? ''}`
            ),
            count = prior?.failure === failure ? prior.count + 1 : 1;
          state[key] = { failure, count };
          entry.sameFailureCount = count;
          entry.requiresAnalysis = count >= 2;
          entry.failureIdentity =
            'step-and-exit-status; inspect logs to confirm the underlying cause';
        }
      }
    }
    if (report.status === 'pass') delete state[key];
    const end = collectSnapshot(root);
    report.sourceChangedDuringRun = end.fingerprint !== snapshot.fingerprint;
    if (report.sourceChangedDuringRun && report.status === 'pass') {
      report.status = 'blocked';
      report.problems.push(
        'Source changed during verification; rerun against the final snapshot.'
      );
    }
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const runDir = mkdtempSync(join(storage, 'run-'));
    report.reportPath = join(runDir, 'result.json');
    report.finishedAt = new Date().toISOString();
    writeFileSync(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    return report;
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = runHarness(
      process.cwd(),
      parseArguments(process.argv.slice(2)),
      {
        onStep: ({ id, status }) => console.error(`[harness] ${id}: ${status}`),
      }
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = ['pass', 'not-run'].includes(result.status) ? 0 : 1;
  } catch {
    // Arbitrary exceptions can contain secrets; never serialize their raw message.
    console.error(
      'Harness could not run. Check arguments, profile definitions, repository root and private evidence directory. No verification pass is recorded.'
    );
    process.exitCode = 1;
  }
}
