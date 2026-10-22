import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { findRelease } from './release-cache.mjs';

const head = 'c'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'woori-release-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'server-previous-run');
  mkdirSync(dir);
  const name = '20261021-ccccccc';
  const bytes = Buffer.from('verified archive fixture');
  const m = {
    schemaVersion: 1,
    deployable: true,
    release: head,
    image: `woori-server:${name}`,
    platform: 'linux/amd64',
    source: { kind: 'commit', commit: head, branch: 'origin/develop' },
    checks: {
      architecture: 'amd64',
      user: 'node',
      revisionLabel: head,
      smoke: { smoke: 'pass', release: head },
      worker: {
        release: head,
        jobsReady: true,
        videoReady: true,
        libx264: true,
        aac: true,
        preset: true,
      },
    },
    archive: {
      file: `woori-server-${name}-amd64.tar.gz`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const save = () =>
    writeFileSync(join(dir, 'release.json'), JSON.stringify(m));
  save();
  writeFileSync(join(dir, m.archive.file), bytes);
  writeFileSync(
    join(dir, 'SHA256SUMS'),
    `${m.archive.sha256}  ${m.archive.file}\n`
  );
  return { root, dir, m, save, bytes };
}
test('DB and server invocations reuse the same verified release archive', async (t) => {
  const f = fixture(t);
  assert.equal(await findRelease([f.root], head), f.dir);
  assert.equal(await findRelease([f.root], head), f.dir);
  assert.equal(await findRelease([f.root], 'd'.repeat(40)), null);
});
test('same-size archive corruption is rejected before reuse', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, f.m.archive.file), Buffer.alloc(f.bytes.length));
  await assert.rejects(findRelease([f.root], head), /SHA256 불일치/);
});
test('non-deployable and failed smoke releases cannot be reused', async (t) => {
  const f = fixture(t);
  f.m.deployable = false;
  f.save();
  await assert.rejects(findRelease([f.root], head), /검증 기록 불일치/);
  f.m.deployable = true;
  f.m.checks.smoke.smoke = 'fail';
  f.save();
  await assert.rejects(findRelease([f.root], head), /검증 기록 불일치/);
});
test('archive path traversal and inconsistent checksum record are rejected', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'SHA256SUMS'), 'wrong');
  await assert.rejects(findRelease([f.root], head), /SHA256SUMS/);
  f.m.archive.file = '../outside';
  f.save();
  await assert.rejects(findRelease([f.root], head), /정보 오류/);
});
test('incomplete or absent release directories do not count as reusable', async (t) => {
  const f = fixture(t);
  rmSync(join(f.dir, 'release.json'));
  assert.equal(
    await findRelease([join(f.root, 'missing'), f.root], head),
    null
  );
});
