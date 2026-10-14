import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('CI bootstrap refuses local invocation and preserves existing env', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'woori-ci-env-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const script = fileURLToPath(
    new URL('./prepare-ci-env.mjs', import.meta.url)
  );
  const run = (env) =>
    spawnSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
  assert.notEqual(run({ CI: 'false', GITHUB_ACTIONS: 'false' }).status, 0);
  const result = run({ CI: 'true', GITHUB_ACTIONS: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(statSync(join(cwd, '.env')).mode & 0o777, 0o600);
  const before = readFileSync(join(cwd, '.env'), 'utf8');
  assert.match(before, /127\.0\.0\.1:55439\/woori_dev/);
  assert.notEqual(run({ CI: 'true', GITHUB_ACTIONS: 'true' }).status, 0);
  assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), before);
});
test('integration runner rejects a nonlocal DB before connecting', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'woori-db-guard-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(
    join(cwd, '.env'),
    'DATABASE_URL=postgresql://test@remote.invalid:5432/woori_dev\nMIGRATION_DATABASE_URL=postgresql://test@remote.invalid:5432/woori_dev\n'
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../run-integration.mjs', import.meta.url))],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://test@remote.invalid:5432/woori_dev',
        MIGRATION_DATABASE_URL:
          'postgresql://test@remote.invalid:5432/woori_dev',
      },
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only accepts the isolated local/);
  assert.doesNotMatch(result.stderr, /ENOTFOUND|ECONNREFUSED/);
});
