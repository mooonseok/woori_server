// Builds the Lightsail server release image (API + worker, linux/amd64) from
// an exact commit and leaves a verifiable archive outside the repository:
//   1. exports the commit with `git archive` (never the working tree, unless
//      --worktree: verification only, no release SHA, never deployable);
//   2. `docker build` with deploy/worker.Dockerfile, WOORI_RELEASE=<commit>;
//   3. checks the image with networking disabled: worker --check (ffmpeg,
//      libx264, AAC, preset, release) and scripts/release-smoke.cjs (source
//      hashes, amd64, non-root, no private files, API boot + /healthz release);
//   4. `docker save | gzip` + SHA256SUMS + release.json.
// Deployable only when the current origin develop or main head (checked with
// `git ls-remote`) contains the commit. A failed run removes its output folder
// and image tag. Does not push, upload, deploy or touch any database; prints
// no configuration values. Commits before this script existed cannot be built
// with it (their Dockerfile has no WOORI_RELEASE); keep earlier images for
// rollback. Run `pnpm build` first (the helpers are compiled TypeScript).
//   node scripts/release-image.mjs                          # HEAD on develop/main
//   node scripts/release-image.mjs --commit origin/develop
//   node scripts/release-image.mjs --worktree               # local check only
// Options: --out <dir> (default ~/.woori/releases/<name>), --allow-unpushed,
// --keep-context.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist/src/common/release/release-plan.js');
if (!existsSync(compiled)) {
  console.error('[release] Run `pnpm build` first.');
  process.exit(1);
}
const {
  ReleaseError,
  RELEASE_PLATFORM,
  RELEASE_BRANCHES,
  dockerIgnoreMatcher,
  imageTag,
  insideRepository,
  migrationSummary,
  parseReleaseArgs,
  remoteReleaseHeads,
  releaseManifest,
  releaseName,
  workerCheckProblems,
} = require(compiled);

const git = (args) =>
  execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
const say = (text) => console.log(`[release] ${text}`);

function docker(args, { quiet = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new ReleaseError(
      `docker ${args[0]} failed${quiet ? `:\n${result.stderr?.toString().slice(-2000)}` : ''}`
    );
  return result.stdout?.toString() ?? '';
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function exportSource(options, sha, context) {
  mkdirSync(context, { recursive: true, mode: 0o700 });
  if (options.source === 'commit') {
    const unpack = spawnSync('tar', ['-x', '-C', context], {
      input: git(['archive', sha]),
      maxBuffer: 256 * 1024 * 1024,
    });
    if (unpack.status !== 0) throw new ReleaseError('Cannot extract commit');
    return;
  }
  const files = git(['ls-files', '-co', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter(Boolean);
  // Symlinks stay links (as in git archive); their targets are not copied in.
  for (const file of files) {
    const from = join(root, file);
    if (!existsSync(from) && !isLink(from)) continue;
    const to = join(context, file);
    const kind = lstatSync(from);
    if (!kind.isFile() && !kind.isSymbolicLink()) continue;
    mkdirSync(dirname(to), { recursive: true });
    if (kind.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Real path even for a not-yet-created folder: resolve the nearest existing
// ancestor. macOS volumes are usually case-insensitive, so compare lowercase.
function realOut(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = join(realpathSync(existing), ...rest);
  return process.platform === 'darwin' ? real.toLowerCase() : real;
}

// The origin develop/main head (as origin has it now) that contains the
// commit, or null. A head missing locally means the clone needs a fetch.
function releaseBranch(sha) {
  const heads = remoteReleaseHeads(
    git(['ls-remote', '--heads', 'origin', ...RELEASE_BRANCHES]).toString()
  );
  let stale = false;
  for (const branch of RELEASE_BRANCHES) {
    const head = heads[branch];
    if (!head) continue;
    const known = spawnSync('git', ['cat-file', '-e', `${head}^{commit}`], {
      cwd: root,
    });
    if (known.status !== 0) {
      stale = true;
      continue;
    }
    const ancestor = spawnSync(
      'git',
      ['merge-base', '--is-ancestor', sha, head],
      { cwd: root }
    );
    if (ancestor.status === 0) return { branch: `origin/${branch}`, stale };
  }
  return { branch: null, stale };
}

// sha256 of every file Docker will copy into /app (the .dockerignore subset).
function sourceManifest(context) {
  const ignored = dockerIgnoreMatcher(
    readFileSync(join(context, '.dockerignore'), 'utf8')
  );
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(context, path).split(sep).join('/');
      if (ignored(rel)) continue;
      const kind = lstatSync(path);
      if (kind.isDirectory()) walk(path);
      else if (kind.isFile()) files[rel] = sha256(readFileSync(path));
    }
  };
  walk(context);
  return { files };
}

// pipeline() destroys every stream on the first error (a full disk included),
// and docker save is killed so it cannot block on a stalled pipe.
async function saveImage(tag, archivePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  const save = spawn('docker', ['save', tag], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolveExit, reject) => {
    save.on('error', reject);
    save.on('close', (code) =>
      code === 0
        ? resolveExit()
        : reject(new ReleaseError('docker save failed'))
    );
  });
  const gzip = createGzip();
  gzip.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  try {
    await Promise.all([
      pipeline(
        save.stdout,
        gzip,
        createWriteStream(archivePath, { mode: 0o600 })
      ),
      exited,
    ]);
  } catch (error) {
    save.kill('SIGKILL');
    throw error;
  }
  return { bytes, sha256: hash.digest('hex') };
}

let created = null;
let builtTag = null;

try {
  const options = parseReleaseArgs(process.argv.slice(2));
  const sha = git(['rev-parse', '--verify', `${options.commit}^{commit}`])
    .toString()
    .trim();
  const { branch, stale } =
    options.source === 'commit'
      ? releaseBranch(sha)
      : { branch: null, stale: false };
  if (options.source === 'commit' && !branch && !options.allowUnpushed)
    throw new ReleaseError(
      `Commit is not on origin develop/main${stale ? ' (run git fetch origin: a remote head is missing locally)' : ''}. Merge and push it first, or pass --allow-unpushed for a non-deployable check.`
    );

  const now = new Date();
  const name = releaseName(sha, options.source, now);
  const tag = imageTag(name);
  const out = resolve(
    options.out ?? join(homedir(), '.woori', 'releases', name)
  );
  if (insideRepository(realOut(out), realOut(root)))
    throw new ReleaseError('--out must be outside the repository');
  if (existsSync(out))
    throw new ReleaseError(`${out} already exists; choose another --out`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  created = out;
  const context = join(out, 'build-context');
  const verification = join(out, 'verification');
  mkdirSync(verification, { mode: 0o700 });

  say(
    `${options.source === 'commit' ? `커밋 ${sha}` : `작업 트리(HEAD ${sha})`} → ${tag} (${RELEASE_PLATFORM})`
  );
  exportSource(options, sha, context);
  const manifest = sourceManifest(context);
  writeFileSync(
    join(verification, 'source-manifest.json'),
    `${JSON.stringify(manifest)}\n`
  );
  const release = options.source === 'commit' ? sha : '';
  const migrations = migrationSummary(
    readdirSync(join(context, 'prisma', 'migrations'))
  );

  // Never retag (or, on failure, delete) an image an earlier run produced.
  if (
    spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' })
      .status === 0
  )
    throw new ReleaseError(
      `${tag} already exists; remove it deliberately or build later`
    );
  say('이미지 빌드 중 (amd64 에뮬레이션이면 수 분 걸립니다)');
  builtTag = tag;
  docker([
    'build',
    '--platform',
    RELEASE_PLATFORM,
    '-f',
    join(context, 'deploy', 'worker.Dockerfile'),
    '--build-arg',
    `WOORI_RELEASE=${release}`,
    '--label',
    `org.opencontainers.image.created=${now.toISOString()}`,
    '-t',
    tag,
    context,
  ]);

  const [architecture, user, label] = docker(
    [
      'image',
      'inspect',
      tag,
      '--format',
      '{{.Architecture}}|{{.Config.User}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ],
    { quiet: true }
  )
    .trim()
    .split('|');
  if (architecture !== 'amd64' || user !== 'node' || label !== release)
    throw new ReleaseError(
      `Image metadata mismatch: arch=${architecture} user=${user} revision label matches=${label === release}`
    );

  const workerLine = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      RELEASE_PLATFORM,
      tag,
      'node',
      'dist/src/worker/main.js',
      '--check',
    ],
    { quiet: true }
  ).trim();
  const workerProblems = workerCheckProblems(workerLine, release || null);
  if (workerProblems.length) throw new ReleaseError(workerProblems.join('; '));
  say('PASS: worker --check (ffmpeg·libx264·AAC·preset·release)');

  copyFileSync(
    join(root, 'scripts', 'release-smoke.cjs'),
    join(verification, 'smoke.cjs')
  );
  const smoke = docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      RELEASE_PLATFORM,
      '-v',
      `${verification}:/verification:ro`,
      '-e',
      `EXPECT_RELEASE=${release}`,
      tag,
      'node',
      '/verification/smoke.cjs',
    ],
    { quiet: true }
  );
  for (const line of smoke.trim().split('\n'))
    if (line.startsWith('PASS')) say(line);

  const archiveFile = `woori-server-${name}-amd64.tar.gz`;
  say('이미지 저장 중');
  const archive = await saveImage(tag, join(out, archiveFile));
  writeFileSync(
    join(out, 'SHA256SUMS'),
    `${archive.sha256}  ${archiveFile}\n`,
    { mode: 0o600 }
  );
  const result = releaseManifest({
    name,
    source: options.source,
    commit: sha,
    branch,
    files: Object.keys(manifest.files).length,
    migrations,
    checks: {
      architecture,
      user,
      revisionLabel: label || null,
      worker: JSON.parse(workerLine),
      smoke: JSON.parse(smoke.trim().split('\n').at(-1)),
    },
    archive: { file: archiveFile, ...archive },
    createdAt: now,
  });
  writeFileSync(
    join(out, 'release.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 }
  );
  if (!options.keepContext) rmSync(context, { recursive: true, force: true });
  say(
    `완료: ${out} (배포 가능: ${result.deployable ? '예' : '아니오'}, 마이그레이션 ${migrations.count}개, 마지막 ${migrations.latest})`
  );
} catch (error) {
  console.error(
    `[release] 실패: ${error instanceof ReleaseError ? error.message : (error?.message ?? error)}`
  );
  // Leave nothing that could be mistaken for a verified release.
  if (created) rmSync(created, { recursive: true, force: true });
  if (builtTag)
    spawnSync('docker', ['image', 'rm', '-f', builtTag], { stdio: 'ignore' });
  process.exitCode = 1;
}
