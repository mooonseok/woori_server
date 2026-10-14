import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  cpSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cleanup, inspect } from './lifecycle.mjs';

function fixture(t, complete = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'woori-handoff-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, '.handoff/remaining-work');
  cpSync(dirname(fileURLToPath(import.meta.url)), folder, { recursive: true });
  const state = JSON.parse(readFileSync(join(folder, 'status.json'), 'utf8'));
  state.tasks = state.tasks.map((task) => ({
    ...task,
    status: complete ? 'done' : 'pending',
    evidence: ['fixture verification only'],
    implementationRefs: ['fixture revision only'],
    peerEvidence: ['fixture peer check only'],
  }));
  state.pendingDecisions = [];
  state.durableDecisionsMoved = true;
  state.permanentRefs = ['project.json'];
  writeFileSync(join(folder, 'status.json'), JSON.stringify(state));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: state.repository })
  );
  writeFileSync(join(root, 'project.json'), '{}\n');
  writeFileSync(
    join(root, 'AGENTS.md'),
    'Permanent instruction\n\n<!-- WOORI_TEMP_HANDOFF_START -->\nTemporary\n<!-- WOORI_TEMP_HANDOFF_END -->\n'
  );
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/keep.ts'), 'export const keep = true;\n');
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'fixture-cleanup');
  git('config', 'user.name', 'Handoff Test');
  git('config', 'user.email', 'handoff@example.test');
  const save = () => {
    writeFileSync(join(folder, 'status.json'), JSON.stringify(state));
    git('add', '.');
    git('commit', '-q', '-m', 'fixture');
  };
  save();
  return { root, folder, state, git, save };
}

test('pending work and missing task IDs/evidence block deletion', (t) => {
  const f = fixture(t, false);
  assert.throws(() => cleanup(f.root, true), /incomplete/);
  assert.ok(existsSync(f.folder));
  f.state.tasks.forEach((task) => {
    task.status = 'done';
  });
  f.state.tasks[0].peerEvidence = [];
  f.save();
  assert.throws(() => cleanup(f.root, true), /missing/);
  f.state.tasks = [];
  f.save();
  assert.throws(() => inspect(f.root), /eight/);
});

test('unknown files and symlinks block cleanup without deleting user material', (t) => {
  const f = fixture(t);
  const unknown = join(f.folder, 'keep.txt');
  writeFileSync(unknown, 'user content');
  assert.throws(() => cleanup(f.root, true), /Unexpected/);
  assert.equal(readFileSync(unknown, 'utf8'), 'user content');
  unlinkSync(unknown);
  unlinkSync(join(f.folder, 'README.md'));
  symlinkSync(join(f.root, 'project.json'), join(f.folder, 'README.md'));
  assert.throws(() => cleanup(f.root, true), /regular/);
  assert.ok(existsSync(join(f.root, 'project.json')));
});

test('protected branches and dirty worktrees block cleanup', (t) => {
  const f = fixture(t);
  f.git('branch', '-m', 'develop');
  assert.throws(() => cleanup(f.root, true), /protected/);
  f.git('branch', '-m', 'fixture-cleanup');
  writeFileSync(join(f.root, 'src/keep.ts'), 'changed');
  assert.throws(() => cleanup(f.root, true), /local changes/);
  assert.equal(readFileSync(join(f.root, 'src/keep.ts'), 'utf8'), 'changed');
});

test('unresolved decisions and temporary durable references block cleanup', (t) => {
  const f = fixture(t);
  f.state.pendingDecisions = ['unresolved'];
  f.save();
  assert.throws(() => cleanup(f.root, true), /unresolved/);
  f.state.pendingDecisions = [];
  f.state.permanentRefs = ['.handoff/remaining-work/DESIGN.md'];
  f.save();
  assert.throws(() => cleanup(f.root, true), /temporary/);
  f.state.permanentRefs = ['../outside'];
  f.save();
  assert.throws(() => cleanup(f.root, true), /relative/);
});

test('dry run preserves everything; apply deletes only bundle and marker block', (t) => {
  const f = fixture(t);
  assert.equal(cleanup(f.root).mode, 'dry-run');
  assert.ok(existsSync(f.folder));
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /Temporary/);
  assert.equal(cleanup(f.root, true).mode, 'applied');
  assert.equal(existsSync(f.folder), false);
  assert.equal(
    readFileSync(join(f.root, 'AGENTS.md'), 'utf8'),
    'Permanent instruction\n'
  );
  assert.equal(
    readFileSync(join(f.root, 'src/keep.ts'), 'utf8'),
    'export const keep = true;\n'
  );
  assert.ok(existsSync(join(f.root, 'package.json')));
  assert.ok(existsSync(join(f.root, 'project.json')));
});
