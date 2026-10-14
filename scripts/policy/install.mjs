import { git, root } from './core.mjs';
import { accessSync, constants } from 'node:fs';
try {
  const cwd = root();
  let old = '';
  try {
    old = git(['config', '--get', 'core.hooksPath'], cwd).trim();
  } catch {
    /* no previous override */
  }
  if (old && old !== '.githooks')
    throw new Error(
      `Existing hooksPath preserved (${old}); reconcile before install.`
    );
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push'])
    accessSync(`${cwd}/.githooks/${hook}`, constants.X_OK);
  git(['config', '--local', 'core.hooksPath', '.githooks'], cwd);
  console.log(
    'Git hooks installed locally. Codex: review project hooks with /hooks; Claude: restart and inspect /hooks.'
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
