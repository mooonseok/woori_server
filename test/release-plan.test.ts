import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReleaseError,
  dockerIgnoreMatcher,
  imageTag,
  insideRepository,
  migrationSummary,
  remoteReleaseHeads,
  parseReleaseArgs,
  releaseManifest,
  releaseName,
  workerCheckProblems,
} from '../src/common/release/release-plan';

const sha = '9ff1a10'.padEnd(40, '0');

test('release arguments: exact commit by default, worktree and unpushed are explicit', () => {
  assert.deepEqual(parseReleaseArgs([]), {
    commit: 'HEAD',
    source: 'commit',
    allowUnpushed: false,
    keepContext: false,
    out: null,
  });
  assert.equal(
    parseReleaseArgs(['--commit', 'origin/develop']).commit,
    'origin/develop'
  );
  const local = parseReleaseArgs(['--worktree', '--out', '/tmp/r']);
  assert.equal(local.source, 'worktree');
  assert.equal(local.out, '/tmp/r');
  assert.equal(parseReleaseArgs(['--allow-unpushed']).allowUnpushed, true);
  for (const bad of [
    ['--commit'],
    ['--commit', '--worktree'],
    ['--commit', 'HEAD;rm -rf /'],
    ['--worktree', '--commit', 'develop'],
    ['--push'],
  ])
    assert.throws(() => parseReleaseArgs(bad), ReleaseError);
});

test('release names use the KST date and short SHA; worktree builds are marked', () => {
  // 2026-10-19 15:30 UTC is already 2026-10-20 in Seoul.
  const now = new Date('2026-10-19T15:30:00Z');
  assert.equal(releaseName(sha, 'commit', now), '20261020-9ff1a10');
  assert.equal(releaseName(sha, 'worktree', now), '20261020-9ff1a10-worktree');
  assert.equal(imageTag('20261020-9ff1a10'), 'woori-server:20261020-9ff1a10');
  assert.throws(() => releaseName('9ff1a10', 'commit', now), ReleaseError);
});

test('.dockerignore subset matches top-level names and refuses other syntax', () => {
  const ignored = dockerIgnoreMatcher(
    'node_modules\ndist\n# comment\n.env\n.env.*\n.git\n'
  );
  for (const path of [
    'node_modules/x/index.js',
    'dist/src/main.js',
    '.env',
    '.env.example',
    '.env.local-db.example',
    '.git/HEAD',
  ])
    assert.equal(ignored(path), true, path);
  for (const path of [
    'src/main.ts',
    'deploy/worker.Dockerfile',
    'src/.env.ts',
    'environment.md',
  ])
    assert.equal(ignored(path), false, path);
  for (const unsupported of ['!keep', 'src/**/*.map', '/dist'])
    assert.throws(() => dockerIgnoreMatcher(unsupported), ReleaseError);
});

test('worker check must report ready video tools and the built release', () => {
  const line = (release: string | null, videoReady = true) =>
    JSON.stringify({
      service: 'woori-worker',
      status: 'bootstrap',
      release,
      jobsReady: true,
      videoReady,
      libx264: true,
      aac: true,
      preset: true,
    });
  assert.deepEqual(workerCheckProblems(line(sha), sha), []);
  assert.deepEqual(workerCheckProblems(line(null), null), []);
  assert.deepEqual(workerCheckProblems(line(null), sha), [
    'worker release does not match the build',
  ]);
  assert.deepEqual(workerCheckProblems(line(sha, false), sha), [
    'worker videoReady is not true',
  ]);
  assert.deepEqual(workerCheckProblems('not json', sha), [
    'worker --check did not print JSON',
  ]);
});

test('deployable means on origin develop/main heads; --out stays outside the repo', () => {
  const other = 'b'.repeat(40);
  assert.deepEqual(
    remoteReleaseHeads(
      `${sha}\trefs/heads/develop\n${other}\trefs/heads/main\n${'c'.repeat(40)}\trefs/heads/feature/x\nnot a line\n`
    ),
    { develop: sha, main: other }
  );
  assert.deepEqual(remoteReleaseHeads(''), {});
  const root = '/users/me/woori/woori_server';
  for (const inside of [root, `${root}/`, `${root}/dist/r`])
    assert.equal(insideRepository(inside.replace(/\/$/, ''), root), true);
  for (const outside of [
    '/users/me/.woori/releases/x',
    '/users/me/woori/woori_server-releases',
    '/users/me/woori',
  ])
    assert.equal(insideRepository(outside, `${root}/`), false);
});

test('release.json: only an exact commit on a release branch is deployable and carries a release', () => {
  assert.deepEqual(
    migrationSummary([
      'migration_lock.toml',
      '20261102000000_neutral_member_copy',
      '20261013000000_initial',
    ]),
    { count: 2, latest: '20261102000000_neutral_member_copy' }
  );
  const base = {
    name: '20261020-9ff1a10',
    commit: sha,
    branch: 'origin/develop',
    files: 300,
    migrations: { count: 21, latest: '20261102000000_neutral_member_copy' },
    contract: '0.30.0',
    checks: {},
    archive: { file: 'a.tar.gz', bytes: 1, sha256: 'f'.repeat(64) },
    createdAt: new Date('2026-10-20T00:00:00Z'),
  };
  const deployable = releaseManifest({ ...base, source: 'commit' });
  assert.equal(deployable.deployable, true);
  assert.equal(deployable.release, sha);
  assert.equal(deployable.image, 'woori-server:20261020-9ff1a10');
  assert.equal(deployable.platform, 'linux/amd64');
  assert.equal(deployable.contract, '0.30.0');
  assert.equal(
    releaseManifest({ ...base, source: 'commit', branch: null }).deployable,
    false
  );
  const worktree = releaseManifest({ ...base, source: 'worktree' });
  assert.equal(worktree.deployable, false);
  assert.equal(worktree.release, null);
});
