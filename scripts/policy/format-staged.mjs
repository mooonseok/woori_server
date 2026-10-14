import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prettier from 'prettier';

// Plan the whole batch first: partial staging or parse errors must not change files.
export async function formatStaged(cwd) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  const names = git([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
  ])
    .split('\0')
    .filter(Boolean);
  const changes = [];
  for (const name of names) {
    const path = join(cwd, name);
    if (!lstatSync(path).isFile()) continue;
    const info = await prettier.getFileInfo(path, {
      ignorePath: join(cwd, '.prettierignore'),
    });
    if (info.ignored || !info.inferredParser) continue;
    const staged = git(['show', `:${name}`]);
    let formatted;
    try {
      formatted = await prettier.format(staged, {
        ...(await prettier.resolveConfig(path)),
        filepath: path,
      });
    } catch {
      throw new Error(
        `Prettier failed: ${name}. Run pnpm format and fix syntax before committing.`
      );
    }
    if (formatted === staged) continue;
    if (readFileSync(path, 'utf8') !== staged) {
      throw new Error(
        `Partial staging: ${name}. Format and review staged changes first; no files were changed.`
      );
    }
    changes.push({ name, path, staged, formatted });
  }
  // Recheck before writes in case an editor changed a file during formatting.
  for (const { name, path, staged } of changes) {
    if (
      readFileSync(path, 'utf8') !== staged ||
      git(['show', `:${name}`]) !== staged
    ) {
      throw new Error(
        `File changed during formatting: ${name}. Review and retry.`
      );
    }
  }
  for (const { name, path, formatted } of changes) {
    writeFileSync(path, formatted);
    git(['add', '--', name]);
  }
  if (changes.length)
    console.log(
      `[woori policy] Prettier formatted ${changes.length} staged file(s).`
    );
}
