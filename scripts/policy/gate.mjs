import { formatStaged } from './format-staged.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  git,
  root,
  protectedRef,
  scanSnapshot,
  checkMigrations,
  messageProblems,
  checkPush,
  verifyCommit,
  zero,
  quality,
} from './core.mjs';
try {
  const cwd = root();
  const mode = process.argv[2];
  if (mode === 'pre-commit') {
    const branch = git(['symbolic-ref', '-q', 'HEAD'], cwd).trim();
    if (protectedRef(branch))
      throw new Error(
        'Direct commit on main/develop blocked. Create a work branch.'
      );
    scanSnapshot(cwd);
    if (
      spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd,
        stdio: 'ignore',
      }).status === 0
    )
      checkMigrations(cwd, 'HEAD');
    await formatStaged(cwd);
    git(['diff', '--cached', '--check'], cwd);
  } else if (mode === 'commit-msg') {
    if (messageProblems(readFileSync(process.argv[3], 'utf8')).length)
      throw new Error('Co-author/tool signature blocked.');
  } else if (mode === 'pre-push') {
    const updates = checkPush(cwd, readFileSync(0, 'utf8'));
    for (const [, local, , remote] of updates) {
      if (zero(local)) continue;
      const base = zero(remote)
        ? git(['merge-base', 'origin/develop', local], cwd).trim()
        : remote;
      const commits = git(['rev-list', `${base}..${local}`], cwd)
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const commit of commits) {
        scanSnapshot(cwd, commit);
        if (
          messageProblems(git(['show', '-s', '--format=%B', commit], cwd))
            .length
        )
          throw new Error('Outgoing commit has prohibited signature.');
      }
      checkMigrations(cwd, base, local);
      verifyCommit(cwd, local);
    }
  } else if (mode === 'ci') {
    scanSnapshot(cwd, 'HEAD');
    const base = process.env.POLICY_BASE_SHA;
    if (base) {
      if (!/^[0-9a-f]{40,64}$/.test(base))
        throw new Error('Invalid CI base revision');
      checkMigrations(cwd, base, 'HEAD');
      for (const commit of git(['rev-list', `${base}..HEAD`], cwd)
        .trim()
        .split('\n')
        .filter(Boolean)) {
        if (
          messageProblems(git(['show', '-s', '--format=%B', commit], cwd))
            .length
        )
          throw new Error('Commit signature blocked.');
      }
    }
  } else if (mode === 'quality') quality(cwd);
  else throw new Error('Unknown policy gate');
} catch (error) {
  console.error(`[woori policy] ${error.message}`);
  process.exitCode = 1;
}
