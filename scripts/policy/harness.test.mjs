import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  collectSnapshot,
  environmentProblems,
  parseArguments,
  runHarness,
  validateProfiles,
} from './harness.mjs';

function fixture(t, repository = 'woori_client') {
  const base = mkdtempSync(join(tmpdir(), 'woori-harness-test-'));
  const root = join(base, 'checkout'),
    storage = join(base, 'evidence');
  mkdirSync(join(root, 'scripts/policy'), { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  const pkg = {
    name: repository,
    packageManager: 'pnpm@10.27.0',
    scripts: {
      'policy:check': 'node scripts/policy/check.mjs',
      'format:check': 'prettier --check .',
    },
  };
  const config = {
    version: 1,
    repository,
    profiles: {
      policy: {
        description: 'Local policy verification',
        steps: [
          { id: 'policy-check', script: 'policy:check' },
          { id: 'format', script: 'format:check' },
        ],
      },
    },
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  writeFileSync(
    join(root, 'scripts/policy/verification-profiles.json'),
    JSON.stringify(config)
  );
  writeFileSync(
    join(root, 'scripts/policy/check.mjs'),
    "console.log('PRIVATE_TEST_SENTINEL'); process.exitCode = 1;\n"
  );
  writeFileSync(join(root, '.nvmrc'), process.versions.node);
  writeFileSync(
    join(root, '.gitignore'),
    'node_modules/\n.env*\ndist/\n.next/\n'
  );
  for (const args of [
    ['init', '-q', '-b', 'harness-fixture'],
    ['add', '.'],
    [
      '-c',
      'user.name=Harness Fixture',
      '-c',
      'user.email=harness@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fixture',
    ],
  ])
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dependencies = {
    storage,
    preflight: () => [],
    environmentProblems: () => [],
    execute: () => ({ status: 0 }),
  };
  return { root, storage, pkg, config, dependencies };
}
const options = { mode: 'verify', profile: 'policy' };

test('dry-run lists exact approved commands without writes, preflight or execution', (t) => {
  const f = fixture(t);
  const fail = () => assert.fail('dry-run executed a dependency');
  const report = runHarness(
    f.root,
    { ...options, dryRun: true },
    {
      storage: f.storage,
      preflight: fail,
      environmentProblems: fail,
      execute: fail,
    }
  );
  assert.equal(report.status, 'not-run');
  assert.deepEqual(report.steps[0].command, ['pnpm', 'run', 'policy:check']);
  assert.equal(existsSync(f.storage), false);
});

test('rejects deploy, altered approved script, shell arguments and unknown CLI flags', (t) => {
  const { root, config, pkg } = fixture(t);
  for (const script of [
    'deploy:web',
    'prisma:migrate:deploy',
    'dev:db:prepare',
    'start:worker',
  ]) {
    const bad = structuredClone(config);
    bad.profiles.policy.steps[0].script = script;
    assert.throws(() => validateProfiles(bad, pkg, root));
  }
  const changed = structuredClone(pkg);
  changed.scripts['policy:check'] = 'pnpm deploy:web';
  assert.throws(() => validateProfiles(config, changed, root));
  const args = structuredClone(config);
  args.profiles.policy.steps[0].args = ['; touch /tmp/unsafe'];
  assert.throws(() => validateProfiles(args, pkg, root));
  const hook = structuredClone(pkg);
  hook.scripts['prepolicy:check'] = 'pnpm deploy:web';
  assert.throws(() => validateProfiles(config, hook, root));
  for (const argv of [
    ['verify'],
    ['verify', '--profile', 'policy', '--force'],
    ['check', '--profile', 'policy'],
    ['verify', '--profile', 'policy', '--profile', 'policy'],
  ])
    assert.throws(() => parseArguments(argv));
});

test('workspace verification uses only approved apps and package definitions', (t) => {
  const { root, pkg, config } = fixture(t);
  mkdirSync(join(root, 'apps/admin'), { recursive: true });
  writeFileSync(
    join(root, 'apps/admin/package.json'),
    JSON.stringify({
      scripts: {
        test: 'node --experimental-strip-types --test tests/*.test.ts',
      },
    })
  );
  config.profiles.policy.steps = [
    { id: 'admin', script: 'test', workspace: '@woori/admin' },
  ];
  assert.equal(validateProfiles(config, pkg, root), config);
  config.profiles.policy.steps[0].workspace = '@woori/unknown';
  assert.throws(() => validateProfiles(config, pkg, root));
});

test('successful checks persist private evidence with source fingerprint', (t) => {
  const f = fixture(t);
  const report = runHarness(f.root, options, f.dependencies);
  assert.equal(report.status, 'pass');
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['pass', 'pass']
  );
  assert.match(report.snapshot.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(statSync(report.reportPath).mode & 0o077, 0);
  assert.equal(statSync(f.storage).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(report.reportPath, 'utf8')), report);
});

test('all environment requirements are checked before any command and remaining checks are not-run', (t) => {
  const f = fixture(t);
  let calls = 0;
  const report = runHarness(f.root, options, {
    ...f.dependencies,
    environmentProblems: (_, step) =>
      step.id === 'format' ? ['Missing local dependency.'] : [],
    execute: () => {
      calls++;
      return { status: 0 };
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['not-run', 'blocked']
  );
});

test('two failures stop blind retry; explicit next hypothesis allows another attempt', (t) => {
  const f = fixture(t);
  let calls = 0;
  const deps = {
    ...f.dependencies,
    execute: () => {
      calls++;
      return {
        status: 1,
        stdout: 'PRIVATE_TEST_SENTINEL',
        stderr: 'postgres://user:password@production/db',
      };
    },
  };
  const first = runHarness(f.root, options, deps);
  assert.equal(first.status, 'fail');
  assert.equal(first.steps[0].classification, 'unknown');
  assert.equal(first.steps[0].sameFailureCount, 1);
  assert.equal(first.steps[1].status, 'not-run');
  const second = runHarness(f.root, options, deps);
  assert.equal(second.steps[0].requiresAnalysis, true);
  assert.equal(second.steps[0].sameFailureCount, 2);
  const third = runHarness(f.root, options, deps);
  assert.equal(third.status, 'blocked');
  assert.equal(calls, 2);
  const recovery = runHarness(
    f.root,
    { ...options, retryReason: 'PRIVATE_TEST_HYPOTHESIS' },
    f.dependencies
  );
  assert.equal(recovery.status, 'pass');
  for (const report of [first, second, third, recovery]) {
    const contents = readFileSync(report.reportPath, 'utf8');
    assert.doesNotMatch(contents, /PRIVATE_TEST|postgres:\/\/|password/);
  }
});

test('launch failure is environment-blocked rather than a code regression', (t) => {
  const f = fixture(t);
  const report = runHarness(f.root, options, {
    ...f.dependencies,
    execute: () => ({ status: null, errorCode: 'ENOENT' }),
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.steps[0].classification, 'environment');
});

test('fingerprint detects tracked edits, untracked code, deletion and symlink target without exposing env values', (t) => {
  const { root } = fixture(t);
  const original = collectSnapshot(root);
  writeFileSync(join(root, '.env'), 'DATABASE_URL=PRIVATE_SECRET_A\n');
  assert.equal(collectSnapshot(root).fingerprint, original.fingerprint);
  writeFileSync(join(root, '.env'), 'DATABASE_URL=PRIVATE_SECRET_B\n');
  assert.equal(collectSnapshot(root).fingerprint, original.fingerprint);
  writeFileSync(join(root, 'new.mjs'), 'export const n = 1;');
  const added = collectSnapshot(root);
  assert.notEqual(added.fingerprint, original.fingerprint);
  assert.equal(added.dirty, true);
  writeFileSync(join(root, 'new.mjs'), 'export const n = 2;');
  assert.notEqual(collectSnapshot(root).fingerprint, added.fingerprint);
  rmSync(join(root, 'new.mjs'));
  symlinkSync('/does/not/exist', join(root, 'linked'));
  assert.notEqual(collectSnapshot(root).fingerprint, original.fingerprint);
  rmSync(join(root, 'linked'));
  rmSync(join(root, 'scripts/policy/check.mjs'));
  assert.notEqual(collectSnapshot(root).fingerprint, original.fingerprint);
});

test('source edits during verification invalidate an otherwise successful result', (t) => {
  const f = fixture(t);
  const report = runHarness(f.root, options, {
    ...f.dependencies,
    execute: () => {
      writeFileSync(join(f.root, 'changed.mjs'), 'export const value = 1;');
      return { status: 0 };
    },
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.sourceChangedDuringRun, true);
});

test('local DB preflight rejects effective production URLs without printing credentials', (t) => {
  const { root } = fixture(t, 'woori_server');
  const local = 'postgresql://fixture:secret@127.0.0.1:55439/woori_dev';
  writeFileSync(
    join(root, '.env'),
    `DATABASE_URL=${local}\nMIGRATION_DATABASE_URL=${local}\n`
  );
  assert.deepEqual(
    environmentProblems(root, { script: 'test:integration' }, {}, () => true),
    []
  );
  const failures = environmentProblems(
    root,
    { script: 'test:integration' },
    {
      DATABASE_URL: 'postgresql://owner:PRIVATE_SENTINEL@production.example/db',
    }
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /DATABASE_URL/);
  assert.doesNotMatch(
    JSON.stringify(failures),
    /PRIVATE_SENTINEL|production.example/
  );
});

test('client builds block on either Next lock and do not remove it', (t) => {
  const { root } = fixture(t);
  const lock = join(root, 'apps/admin/.next/dev/lock');
  mkdirSync(join(root, 'apps/admin/.next/dev'), { recursive: true });
  writeFileSync(lock, '');
  assert.ok(environmentProblems(root, { script: 'build' }).length > 0);
  assert.equal(existsSync(lock), true);
});

test('real pnpm subprocess output is suppressed and CLI returns nonzero on failure', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('./harness.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [script, 'verify', '--profile', 'policy'],
    { cwd: f.root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_SENTINEL/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.steps[0].status, 'fail');
  assert.equal(report.steps[0].exitCode, 1);
  assert.doesNotMatch(
    readFileSync(report.reportPath, 'utf8'),
    /PRIVATE_TEST_SENTINEL/
  );
  // Remove only this fixture's evidence (the parent harness's evidence is untouched).
  t.after(() =>
    rmSync(join(report.reportPath, '..', '..'), {
      recursive: true,
      force: true,
    })
  );
});

test('transitive server test commands cannot redirect build or local deployment tests', (t) => {
  const { root, config, pkg } = fixture(t, 'woori_server');
  config.profiles.policy.steps = [{ id: 'tests', script: 'test' }];
  Object.assign(pkg.scripts, {
    test: 'pnpm build && node --test dist/test/*.test.js && pnpm test:deploy:local',
    build: 'prisma generate && nest build',
    'test:deploy:local': 'node --test scripts/local-deploy/*.test.mjs',
  });
  assert.equal(validateProfiles(config, pkg, root), config);
  pkg.scripts.build = 'pnpm deploy:server';
  assert.throws(() => validateProfiles(config, pkg, root), /Delegated script/);
  pkg.scripts.build = 'prisma generate && nest build';
  pkg.scripts['test:deploy:local'] = 'pnpm deploy:db';
  assert.throws(() => validateProfiles(config, pkg, root), /Delegated script/);
});

test('recursive client tasks validate both workspace definitions', (t) => {
  const { root, config, pkg } = fixture(t);
  config.profiles.policy.steps = [{ id: 'build', script: 'build' }];
  pkg.scripts.build = 'pnpm -r build';
  for (const app of ['web', 'admin']) {
    mkdirSync(join(root, 'apps', app), { recursive: true });
    writeFileSync(
      join(root, 'apps', app, 'package.json'),
      JSON.stringify({ scripts: { build: 'next build' } })
    );
  }
  assert.equal(validateProfiles(config, pkg, root), config);
  writeFileSync(
    join(root, 'apps/admin/package.json'),
    JSON.stringify({ scripts: { build: 'pnpm deploy:web' } })
  );
  assert.throws(
    () => validateProfiles(config, pkg, root),
    /Delegated workspace/
  );
});

test('evidence symlink ancestors cannot create report directories in the checkout', (t) => {
  const f = fixture(t);
  const alias = join(f.storage, '..', 'alias');
  symlinkSync(f.root, alias);
  assert.throws(
    () =>
      runHarness(f.root, options, {
        ...f.dependencies,
        storage: join(alias, 'forbidden-evidence'),
      }),
    /Evidence must not resolve/
  );
  assert.equal(existsSync(join(f.root, 'forbidden-evidence')), false);
});

test('PostgreSQL connection query overrides are blocked before any local probe', (t) => {
  const { root } = fixture(t, 'woori_server');
  const base = 'postgresql://fixture:secret@127.0.0.1:55439/woori_dev';
  writeFileSync(
    join(root, '.env'),
    `DATABASE_URL=${base}\nMIGRATION_DATABASE_URL=${base}\n`
  );
  for (const query of [
    'host=external.example',
    'port=5432',
    '%68ost=external.example',
    'database=production',
    'options=unsafe',
    'sslmode=disable',
  ]) {
    let probes = 0;
    const errors = environmentProblems(
      root,
      { script: 'test:integration' },
      { DATABASE_URL: `${base}?${query}` },
      () => {
        probes++;
        return true;
      }
    );
    assert.equal(errors.length, 1);
    assert.equal(probes, 0);
    assert.match(errors[0], /DATABASE_URL/);
    assert.doesNotMatch(JSON.stringify(errors), /external.example|secret/);
  }
  assert.deepEqual(
    environmentProblems(
      root,
      { script: 'test:integration' },
      { DATABASE_URL: `${base}?schema=woori` },
      () => true
    ),
    []
  );
});

test('local DB unavailable is reported as environment failure before integration', (t) => {
  const { root } = fixture(t, 'woori_server');
  const url = 'postgresql://fixture:secret@127.0.0.1:55439/woori_dev';
  writeFileSync(
    join(root, '.env'),
    `DATABASE_URL=${url}\nMIGRATION_DATABASE_URL=${url}\n`
  );
  const errors = environmentProblems(
    root,
    { script: 'test:integration' },
    {},
    () => false
  );
  assert.deepEqual(errors, [
    'The isolated local PostgreSQL port is unavailable; start the approved local service separately.',
  ]);
});

test('progress callbacks expose only safe step identifiers and state', (t) => {
  const f = fixture(t),
    events = [];
  runHarness(f.root, options, {
    ...f.dependencies,
    onStep: (event) => events.push(event),
  });
  assert.deepEqual(events, [
    { id: 'policy-check', status: 'running' },
    { id: 'policy-check', status: 'pass' },
    { id: 'format', status: 'running' },
    { id: 'format', status: 'pass' },
  ]);
});
