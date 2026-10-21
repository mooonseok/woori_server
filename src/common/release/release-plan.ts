// Pure helpers for scripts/release-image.mjs: argument rules, release names,
// the .dockerignore subset the image build uses, worker-check expectations and
// the release.json shape. Git, Docker and file IO stay in the script.

export class ReleaseError extends Error {}

export type ReleaseSource = 'commit' | 'worktree';

export interface ReleaseOptions {
  commit: string;
  source: ReleaseSource;
  allowUnpushed: boolean;
  keepContext: boolean;
  out: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
export const isFullSha = (value: unknown): value is string =>
  typeof value === 'string' && FULL_SHA.test(value);

export const RELEASE_PLATFORM = 'linux/amd64';

// Only commits already on these origin branches are deployable; a commit only
// on a feature branch, or not pushed at all, builds for verification only.
export const RELEASE_BRANCHES = ['develop', 'main'] as const;

// `git ls-remote --heads origin develop main` -> branch -> head SHA.
export function remoteReleaseHeads(output: string): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    const branch = ref?.replace(/^refs\/heads\//, '');
    if (
      isFullSha(sha) &&
      branch &&
      (RELEASE_BRANCHES as readonly string[]).includes(branch)
    )
      heads[branch] = sha;
  }
  return heads;
}

// --out must not land in the repository (an image archive and a full source
// copy would appear there). Compares real paths; macOS volumes are usually
// case-insensitive, so the caller passes lowercase paths there.
export function insideRepository(out: string, root: string) {
  const base = root.replace(/\/+$/, '');
  return out === base || out.startsWith(`${base}/`);
}

// --commit picks what to export (default HEAD). --worktree builds the current
// tracked + untracked files instead; such an image never carries a release SHA
// and is never deployable. --allow-unpushed accepts a commit that is not on
// origin develop/main (verification only, also not deployable).
export function parseReleaseArgs(argv: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    commit: 'HEAD',
    source: 'commit',
    allowUnpushed: false,
    keepContext: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith('--'))
        throw new ReleaseError(`${arg} needs a value`);
      return next;
    };
    if (arg === '--commit') options.commit = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--worktree') options.source = 'worktree';
    else if (arg === '--allow-unpushed') options.allowUnpushed = true;
    else if (arg === '--keep-context') options.keepContext = true;
    else throw new ReleaseError(`Unknown option ${arg}`);
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(options.commit))
    throw new ReleaseError('--commit must be a plain revision name');
  if (options.source === 'worktree' && options.commit !== 'HEAD')
    throw new ReleaseError('--worktree builds the checkout; drop --commit');
  return options;
}

// 20261020-9ff1a10 (KST date + short SHA); a worktree build is marked as such.
export function releaseName(
  sha: string,
  source: ReleaseSource,
  now: Date
): string {
  if (!isFullSha(sha)) throw new ReleaseError('Release needs a full git SHA');
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .replaceAll('-', '');
  return `${day}-${sha.slice(0, 7)}${source === 'worktree' ? '-worktree' : ''}`;
}

export const imageTag = (name: string) => `woori-server:${name}`;

// The repository .dockerignore only uses top-level names and `*` globs; any
// other syntax fails here instead of silently drifting from Docker's rules.
export function dockerIgnoreMatcher(text: string) {
  const patterns = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  for (const pattern of patterns)
    if (!/^[A-Za-z0-9._*-]+$/.test(pattern))
      throw new ReleaseError(`Unsupported .dockerignore pattern: ${pattern}`);
  const rules = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`
      )
  );
  return (path: string) => {
    const top = path.split('/')[0];
    return rules.some((rule) => rule.test(top));
  };
}

// Expected `node dist/src/worker/main.js --check` line of a release image.
export function workerCheckProblems(
  line: string,
  release: string | null
): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return ['worker --check did not print JSON'];
  }
  const problems: string[] = [];
  for (const key of ['jobsReady', 'videoReady', 'libx264', 'aac', 'preset'])
    if (parsed[key] !== true) problems.push(`worker ${key} is not true`);
  if (parsed.release !== release)
    problems.push('worker release does not match the build');
  return problems;
}

export function migrationSummary(names: string[]) {
  const migrations = names.filter((name) => /^\d{14}_[a-z0-9_]+$/.test(name));
  migrations.sort();
  return {
    count: migrations.length,
    latest: migrations.at(-1) ?? null,
  };
}

export interface ReleaseManifestInput {
  name: string;
  source: ReleaseSource;
  commit: string;
  // The origin release branch whose current head contains the commit.
  branch: string | null;
  files: number;
  migrations: { count: number; latest: string | null };
  // The contract version the image's /healthz reported in the smoke check
  // (null for releases before the field existed).
  contract: string | null;
  checks: Record<string, unknown>;
  archive: { file: string; bytes: number; sha256: string };
  createdAt: Date;
}

// release.json: what was built, from where, and whether it may be deployed.
export function releaseManifest(input: ReleaseManifestInput) {
  const release = input.source === 'commit' ? input.commit : null;
  return {
    schemaVersion: 1,
    image: imageTag(input.name),
    platform: RELEASE_PLATFORM,
    release,
    deployable: input.source === 'commit' && input.branch !== null,
    source: {
      kind: input.source,
      commit: input.commit,
      branch: input.branch,
      files: input.files,
    },
    migrations: input.migrations,
    contract: input.contract,
    checks: input.checks,
    archive: input.archive,
    createdAt: input.createdAt.toISOString(),
  };
}
