import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnv, privateEnv, run } from './common.mjs';
import { validateOwner, allowReviewedChecks } from './manual-db.mjs';

test('build subprocess does not inherit production credentials', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'must-not-reach-build';
  process.env.MIGRATION_DATABASE_URL = 'must-not-reach-build';
  try {
    const r = await run(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify([process.env.CLOUDFLARE_API_TOKEN,process.env.MIGRATION_DATABASE_URL]))',
      ],
      { env: buildEnv(), capture: true }
    );
    assert.equal(r.out, '[null,null]');
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.MIGRATION_DATABASE_URL;
  }
});
test('private env rejects group-readable files and never evaluates shell code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'woori-env-test-'));
  const path = join(dir, 'secret.env');
  try {
    writeFileSync(path, 'KEY="$(echo forbidden)"\n', { mode: 0o600 });
    assert.equal(privateEnv(path).KEY, '$(echo forbidden)');
    chmodSync(path, 0o644);
    assert.throws(() => privateEnv(path), /600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('manual DB path permits reviewed checks but rejects destructive SQL and ledger faults', () => {
  allowReviewedChecks(
    { manual: [{ kind: 'alter table: add constraint check' }] },
    { code: 21 }
  );
  assert.throws(() =>
    allowReviewedChecks({ manual: [{ kind: 'drop table' }] }, { code: 21 })
  );
  assert.throws(() => allowReviewedChecks({ manual: [] }, { code: 22 }));
  assert.throws(() => allowReviewedChecks({ manual: [] }, { code: 21 }));
});
test('manual DB validates production identity and verified TLS', () => {
  const url =
    'postgresql://postgres.okxdxoqgqejudnpcznpd:fixture@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/tmp/fixture.crt';
  assert.equal(validateOwner(url).port, '5432');
  for (const bad of [
    url.replace('verify-full', 'require'),
    url.replace('postgresql:', 'https:'),
    url.replace(':fixture@', '@'),
    url.replace('postgres.okxd', 'woori_api.okxd'),
    url.replace('/postgres?', '/other?'),
    url + '&uselibpqcompat=true',
  ])
    assert.throws(() => validateOwner(bad));
});
