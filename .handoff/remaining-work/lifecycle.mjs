import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  realpathSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const files = [
  'README.md',
  'DESIGN.md',
  'PLAN.md',
  'REPOSITORY.md',
  'SETUP.md',
  'CLEANUP.md',
  'status.json',
  'lifecycle.mjs',
  'lifecycle.test.mjs',
];
const taskIds = Array.from({ length: 8 }, (_, i) => `W0${i + 1}`);
const start = '<!-- WOORI_TEMP_HANDOFF_START -->';
const end = '<!-- WOORI_TEMP_HANDOFF_END -->';
const requireThat = (condition, message) => {
  if (!condition) throw new Error(message);
};
const strings = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'string' && item.trim().length > 0);

export function inspect(root) {
  requireThat(
    realpathSync(root) === resolve(root),
    'Repository path must be canonical.'
  );
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  requireThat(
    realpathSync(git('rev-parse', '--show-toplevel')) === root,
    'Run from the actual repository root.'
  );
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  requireThat(
    ['woori_client', 'woori_server'].includes(pkg.name),
    'Unexpected repository.'
  );
  const folder = join(root, '.handoff', 'remaining-work');
  for (const path of [join(root, '.handoff'), folder]) {
    requireThat(
      !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory(),
      'Symlink/directory boundary rejected.'
    );
  }
  const entries = readdirSync(folder).sort();
  requireThat(
    JSON.stringify(entries) === JSON.stringify([...files].sort()),
    'Unexpected or missing handoff files; review before cleanup.'
  );
  for (const name of files) {
    const info = lstatSync(join(folder, name));
    requireThat(
      info.isFile() && !info.isSymbolicLink(),
      'Only regular handoff files allowed.'
    );
  }
  const state = JSON.parse(readFileSync(join(folder, 'status.json'), 'utf8'));
  requireThat(
    state.schemaVersion === 1 && state.repository === pkg.name,
    'State repository/version mismatch.'
  );
  requireThat(
    Array.isArray(state.tasks) &&
      JSON.stringify(state.tasks.map((t) => t.id).sort()) ===
        JSON.stringify(taskIds),
    'All eight unique task IDs are required.'
  );
  requireThat(
    state.tasks.every((t) =>
      ['pending', 'in_progress', 'done'].includes(t.status)
    ),
    'Invalid task status.'
  );
  requireThat(
    Array.isArray(state.pendingDecisions),
    'pendingDecisions must be an array.'
  );
  requireThat(
    typeof state.durableDecisionsMoved === 'boolean' &&
      Array.isArray(state.permanentRefs),
    'Invalid durable handoff state.'
  );
  return { git, folder, state };
}

export function cleanup(root, apply = false) {
  const { git, folder, state } = inspect(root);
  requireThat(
    state.tasks.every(
      (t) =>
        t.status === 'done' &&
        strings(t.evidence) &&
        strings(t.implementationRefs) &&
        strings(t.peerEvidence)
    ),
    'Cleanup blocked: incomplete tasks or missing implementation/verification/peer evidence.'
  );
  requireThat(
    state.pendingDecisions.length === 0 &&
      state.durableDecisionsMoved === true &&
      strings(state.permanentRefs),
    'Cleanup blocked: unresolved decisions or durable handoff missing.'
  );
  for (const reference of state.permanentRefs) {
    requireThat(
      !isAbsolute(reference) && !reference.split(/[\\/]/).includes('..'),
      'Durable references must be repository-relative.'
    );
    const path = resolve(root, reference);
    const local = relative(root, realpathSync(path));
    requireThat(
      local &&
        !local.startsWith(`..${sep}`) &&
        !isAbsolute(local) &&
        !local.split(sep).includes('.handoff'),
      'Durable references cannot escape the repository or point into temporary handoff.'
    );
    requireThat(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      'Durable reference must be a regular file.'
    );
    git('ls-files', '--error-unmatch', '--', reference);
  }
  const branch = git('symbolic-ref', '--short', 'HEAD');
  requireThat(
    !['main', 'develop', 'master'].includes(branch),
    'Cleanup on a protected branch is blocked.'
  );
  requireThat(
    git('status', '--porcelain', '--untracked-files=all') === '',
    'Commit completion evidence and preserve all local changes before cleanup.'
  );
  for (const name of files)
    git('ls-files', '--error-unmatch', '--', `.handoff/remaining-work/${name}`);
  git('ls-files', '--error-unmatch', '--', 'AGENTS.md');
  const agentsPath = join(root, 'AGENTS.md');
  requireThat(
    lstatSync(agentsPath).isFile() && !lstatSync(agentsPath).isSymbolicLink(),
    'AGENTS must be a regular file.'
  );
  const agents = readFileSync(agentsPath, 'utf8');
  requireThat(
    agents.split(start).length === 2 &&
      agents.split(end).length === 2 &&
      agents.indexOf(start) < agents.indexOf(end),
    'Missing or duplicate handoff markers.'
  );
  const cleaned =
    (
      agents.slice(0, agents.indexOf(start)) +
      agents.slice(agents.indexOf(end) + end.length)
    ).trimEnd() + '\n';
  const paths = files.map((name) => `.handoff/remaining-work/${name}`);
  if (apply) {
    writeFileSync(agentsPath, cleaned);
    for (const name of files) unlinkSync(join(folder, name));
    rmdirSync(folder);
    // Keep the parent directory and all other handoff bundles intact.
  }
  return {
    mode: apply ? 'applied' : 'dry-run',
    removed: paths,
    edited: ['AGENTS.md (temporary marker block only)'],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const root = realpathSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    );
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === 'status') {
      const { state } = inspect(root);
      console.log(
        JSON.stringify(
          {
            repository: state.repository,
            tasks: state.tasks.map(({ id, status }) => ({ id, status })),
            pendingDecisions: state.pendingDecisions.length,
            durableDecisionsMoved: state.durableDecisionsMoved,
          },
          null,
          2
        )
      );
    } else if (
      args[0] === 'cleanup' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--apply'))
    ) {
      console.log(
        JSON.stringify(cleanup(root, args[1] === '--apply'), null, 2)
      );
    } else throw new Error('Usage: lifecycle.mjs status | cleanup [--apply]');
  } catch (error) {
    console.error(`[handoff] ${error.message}`);
    process.exitCode = 1;
  }
}
