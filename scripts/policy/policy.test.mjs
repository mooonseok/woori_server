import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  contentProblems,
  messageProblems,
  checkPush,
  quality,
} from './core.mjs';
import { evaluate } from './tool-guard.mjs';
const source = resolve(fileURLToPath(new URL('../..', import.meta.url)));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'woori-policy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invoke = (args, options = {}) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', ...options });
  for (const args of [
    ['init', '-b', 'feature/test'],
    ['config', 'user.name', 'Policy Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'commit.gpgsign', 'false'],
  ])
    assert.equal(invoke(args).status, 0);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(source, 'scripts/policy'), join(dir, 'scripts/policy'), {
    recursive: true,
  });
  cpSync(join(source, '.githooks'), join(dir, '.githooks'), {
    recursive: true,
  });
  writeFileSync(join(dir, '.nvmrc'), '24.12.0\n');
  assert.equal(invoke(['config', 'core.hooksPath', '.githooks']).status, 0);
  const write = (name, value) => {
    mkdirSync(resolve(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), value);
  };
  const commit = () => {
    assert.equal(invoke(['add', '.']).status, 0);
    return invoke(['commit', '-m', '검사 fixture 추가']);
  };
  write('.gitignore', 'node_modules/\n');
  cpSync(join(source, '.prettierrc.json'), join(dir, '.prettierrc.json'));
  cpSync(join(source, '.prettierignore'), join(dir, '.prettierignore'));
  symlinkSync(
    join(source, 'node_modules'),
    join(dir, 'node_modules'),
    'junction'
  );
  write('hello.txt', 'safe\n');
  assert.equal(commit().status, 0);
  return {
    dir,
    invoke,
    write,
    commit,
    sha: () => invoke(['rev-parse', 'HEAD']).stdout.trim(),
  };
}
test('recognized credentials are redacted and env examples remain allowed', () => {
  assert.deepEqual(contentProblems('.env.example', 'PASSWORD=REPLACE'), []);
  assert.ok(contentProblems('.env.production', 'password=private').length);
  const token = ['ghp_', 'a'.repeat(36)].join('');
  const result = contentProblems('config.ts', token).join(' ');
  assert.match(result, /line 1/);
  assert.ok(!result.includes(token));
  assert.ok(contentProblems('CLAUDE.md', 'x\n'.repeat(201)).length);
});
test('commit signatures are rejected without restricting normal Korean messages', () => {
  assert.deepEqual(messageProblems('인증 처리 추가\n\n- 세션 검증 보완'), []);
  assert.ok(
    messageProblems('변경\n\nCo-authored-by: Agent <agent@example.invalid>')
      .length
  );
});
test('real installed pre-commit permits feature commits and blocks protected branch commit', (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(['switch', '-c', 'develop']).status, 0);
  f.write('hello.txt', 'changed\n');
  const before = f.sha();
  assert.notEqual(f.commit().status, 0);
  assert.equal(f.sha(), before);
});
test('staged forbidden file blocked even when worktree removes its content', (t) => {
  const f = fixture(t);
  f.write('.env', 'SECRET=test');
  assert.equal(f.invoke(['add', '--force', '.env']).status, 0);
  f.write('.env', '');
  assert.notEqual(f.invoke(['commit', '-m', '환경 추가']).status, 0);
});
test('staged token blocked even when worktree is safe', (t) => {
  const f = fixture(t);
  f.write('hello.txt', ['ghp_', 'b'.repeat(36)].join(''));
  f.invoke(['add', 'hello.txt']);
  f.write('hello.txt', 'safe');
  const result = f.invoke(['commit', '-m', '변경']);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes('b'.repeat(36)));
});
test('actual commit-msg hook rejects coauthor', (t) => {
  const f = fixture(t);
  f.write('hello.txt', 'changed');
  f.invoke(['add', '.']);
  assert.notEqual(
    f.invoke([
      'commit',
      '-m',
      '변경\n\nCo-authored-by: Bot <bot@example.invalid>',
    ]).status,
    0
  );
});
test('existing migration modification and deletion blocked, new migration allowed', (t) => {
  const f = fixture(t);
  f.write('prisma/migrations/001/migration.sql', 'SELECT 1;');
  assert.equal(f.commit().status, 0);
  f.write('prisma/migrations/002/migration.sql', 'SELECT 2;');
  assert.equal(f.commit().status, 0);
  f.write('prisma/migrations/001/migration.sql', 'SELECT 3;');
  assert.notEqual(f.commit().status, 0);
  f.invoke([
    'restore',
    '--staged',
    '--worktree',
    'prisma/migrations/001/migration.sql',
  ]);
  f.invoke(['rm', 'prisma/migrations/001/migration.sql']);
  assert.notEqual(f.invoke(['commit', '-m', '삭제']).status, 0);
});
test('installed pre-push blocks aliases, deletion and protected refs without network push', (t) => {
  const f = fixture(t);
  const zero = '0'.repeat(40);
  for (const update of [
    `HEAD ${f.sha()} refs/heads/develop ${zero}`,
    `(delete) ${zero} refs/heads/main ${f.sha()}`,
  ]) {
    const inputPath = join(f.dir, 'push-input.txt');
    writeFileSync(inputPath, update + '\n');
    const result = f.invoke([
      'hook',
      'run',
      `--to-stdin=${inputPath}`,
      'pre-push',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Direct update/);
  }
  assert.deepEqual(checkPush(f.dir, ''), []);
});
test('feature fast-forward allowed and diverging update rejected', (t) => {
  const f = fixture(t);
  const base = f.sha();
  f.write('hello.txt', 'next');
  assert.equal(f.commit().status, 0);
  const tip = f.sha();
  assert.equal(
    checkPush(f.dir, `HEAD ${tip} refs/heads/feature ${base}`).length,
    1
  );
  assert.throws(
    () => checkPush(f.dir, `HEAD ${base} refs/heads/feature ${tip}`),
    /Non-fast-forward/
  );
  assert.throws(() => checkPush(f.dir, 'malformed'), /Invalid/);
});
function runPushHook(f, local, remote, env = process.env) {
  const inputPath = join(f.dir, 'push-input.txt');
  writeFileSync(
    inputPath,
    `refs/heads/feature/test ${local} refs/heads/feature/test ${remote}\n`
  );
  return f.invoke(['hook', 'run', `--to-stdin=${inputPath}`, 'pre-push'], {
    env,
  });
}

for (const name of ['woori_client', 'woori_server']) {
  test(`${name}: installed pre-push needs no dependencies or DB and checks the outgoing snapshot`, (t) => {
    const f = fixture(t);
    const base = f.sha();
    assert.equal(
      f.invoke(['update-ref', 'refs/remotes/origin/develop', base]).status,
      0
    );
    f.write(
      'package.json',
      JSON.stringify({ name, scripts: { build: 'exit 73', test: 'exit 73' } })
    );
    f.write('snapshot.txt', 'committed');
    assert.equal(f.commit().status, 0);
    const local = f.sha();
    unlinkSync(join(f.dir, 'node_modules'));
    // Dirty/index credentials must not affect the already-created outgoing commit.
    f.write('snapshot.txt', ['ghp_', 'x'.repeat(36)].join(''));
    assert.equal(f.invoke(['add', 'snapshot.txt']).status, 0);
    const before = f.invoke(['diff', '--cached']).stdout;
    const bin = mkdtempSync(join(tmpdir(), 'woori-no-heavy-push-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    for (const tool of ['pnpm', 'docker', 'psql']) {
      writeFileSync(
        join(bin, tool),
        '#!/bin/sh\nprintf called >> "$WOORI_POLICY_CALLS"\nexit 73\n'
      );
      chmodSync(join(bin, tool), 0o755);
    }
    const marker = join(bin, 'calls');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NVM_DIR: join(bin, 'no-nvm-override'),
      WOORI_POLICY_CALLS: marker,
    };
    // Existing and new remote branches both work, without a local .env.
    for (const remote of [base, '0'.repeat(40)]) {
      const result = runPushHook(f, local, remote, env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /full tests and builds run in PR Quality/
      );
    }
    f.write('.env', 'not a valid database configuration');
    assert.equal(runPushHook(f, local, base, env).status, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(f.invoke(['diff', '--cached']).stdout, before);
    assert.equal(
      readFileSync(join(f.dir, 'snapshot.txt'), 'utf8'),
      ['ghp_', 'x'.repeat(36)].join('')
    );
  });
}

// Construct external-style commits only inside disposable fixtures. The installed
// pre-push hook must inspect them even if local pre-commit never saw the content.
function externalCommit(f, message) {
  assert.equal(f.invoke(['add', '.']).status, 0);
  const tree = f.invoke(['write-tree']);
  assert.equal(tree.status, 0, tree.stderr);
  const result = f.invoke(['commit-tree', tree.stdout.trim(), '-p', f.sha()], {
    input: `${message}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const sha = result.stdout.trim();
  assert.equal(f.invoke(['update-ref', 'HEAD', sha]).status, 0);
  return sha;
}

for (const kind of ['credential', 'signature', 'migration']) {
  test(`installed fast pre-push still rejects outgoing ${kind} violations`, (t) => {
    const f = fixture(t);
    f.write('prisma/migrations/001/migration.sql', 'SELECT 1;');
    assert.equal(f.commit().status, 0);
    const base = f.sha();
    const secret = ['ghp_', 'y'.repeat(36)].join('');
    if (kind === 'credential') f.write('config.txt', secret);
    if (kind === 'migration')
      f.write('prisma/migrations/001/migration.sql', 'SELECT 2;');
    const bad = externalCommit(
      f,
      kind === 'signature'
        ? '외부 변경\n\nCo-authored-by: Fixture <fixture@example.invalid>'
        : '외부 변경'
    );
    // A clean tip must not conceal a credential in an earlier outgoing commit.
    let local = bad;
    if (kind === 'credential') {
      f.write('config.txt', 'clean');
      local = externalCommit(f, '노출 값 제거');
    }
    const result = runPushHook(f, local, base);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      kind === 'credential'
        ? /recognized credential/
        : kind === 'signature'
          ? /prohibited signature/
          : /Existing migration/
    );
    assert.ok(!result.stderr.includes(secret));
  });
}

test('PR Quality remains wired to full checks and propagates failures', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'woori-quality-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'pnpm'),
    calls = join(dir, 'calls');
  writeFileSync(
    fake,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WOORI_POLICY_CALLS"\n[ "$*" != "run $WOORI_FAIL_TASK" ] || exit 7\n'
  );
  chmodSync(fake, 0o755);
  const previous = {
    PATH: process.env.PATH,
    WOORI_POLICY_CALLS: process.env.WOORI_POLICY_CALLS,
    WOORI_FAIL_TASK: process.env.WOORI_FAIL_TASK,
  };
  Object.assign(process.env, {
    PATH: `${dir}:${process.env.PATH}`,
    WOORI_POLICY_CALLS: calls,
    WOORI_FAIL_TASK: '',
  });
  try {
    for (const [name, expected] of [
      [
        'woori_client',
        [
          'policy:check',
          'policy:test',
          'lint',
          'typecheck',
          'test',
          'check:boundaries',
          'format:check',
          'build',
        ],
      ],
      [
        'woori_server',
        [
          'policy:check',
          'policy:test',
          'format:check',
          'prisma:validate',
          'typecheck',
          'test',
          'test:integration',
        ],
      ],
    ]) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
      writeFileSync(calls, '');
      quality(dir);
      assert.deepEqual(
        readFileSync(calls, 'utf8').trim().split('\n'),
        expected.map((task) => `run ${task}`)
      );
    }
    process.env.WOORI_FAIL_TASK = 'test';
    writeFileSync(calls, '');
    assert.throws(() => quality(dir), /pnpm failed \(7\)/);
    assert.ok(!readFileSync(calls, 'utf8').includes('run test:integration'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const workflow = readFileSync(
    join(source, '.github/workflows/quality.yml'),
    'utf8'
  );
  assert.match(workflow, /\n  pull_request:/);
  assert.match(workflow, /\n      - run: pnpm policy:quality\n/);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name === 'woori_server') {
    assert.match(pkg.scripts.test, /pnpm build/);
    assert.match(pkg.scripts['test:integration'], /pnpm build/);
    assert.match(workflow, /Prepare isolated CI database/);
  } else assert.equal(pkg.scripts.build, 'pnpm -r build');
});

test('both tool adapters permit safe commands, deny prohibited commands and malformed input', () => {
  for (const adapter of [
    '.claude/hooks/pre-tool-use.mjs',
    '.codex/hooks/pre-tool-use.mjs',
  ]) {
    for (const [command, denied] of [
      ['git status --short', false],
      ['pnpm test', false],
      ['git push origin HEAD:develop', true],
      ['git -c core.hooksPath=/dev/null commit -m x', true],
      ['git push --no-verify', true],
      ['pnpm exec prisma migrate reset --force', true],
      ['docker compose down -v', true],
    ]) {
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      });
      const result = spawnSync(process.execPath, [join(source, adapter)], {
        input,
        encoding: 'utf8',
      });
      assert.equal(result.status, denied ? 2 : 0, command);
      if (denied)
        assert.equal(
          JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
          'deny'
        );
    }
    assert.equal(
      spawnSync(process.execPath, [join(source, adapter)], {
        input: '{bad',
        encoding: 'utf8',
      }).status,
      2
    );
  }
  assert.equal(
    evaluate({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo "git push origin develop"' },
    }),
    null
  );
});

test('registered hook commands work from a nested project directory', () => {
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(source, file), 'utf8'));
    const command = config.hooks.PreToolUse[0].hooks[0].command;
    for (const [toolCommand, status] of [
      ['git status --short', 0],
      ['git push origin HEAD:develop', 2],
    ]) {
      const result = spawnSync('sh', ['-c', command], {
        cwd: join(source, 'scripts'),
        encoding: 'utf8',
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: toolCommand },
        }),
      });
      assert.equal(result.status, status, result.stderr);
    }
  }
});

test('pre-commit formats staged source with spaces and preserves unrelated edits', (t) => {
  const f = fixture(t);
  f.write('hello.txt', 'keep this unstaged\n');
  f.write('new file.ts', 'export const value={name:"hello",items:[1,2]}');
  assert.equal(f.invoke(['add', '--', 'new file.ts']).status, 0);
  const result = f.invoke(['commit', '-m', '포맷 검사']);
  assert.equal(result.status, 0, result.stderr);
  const formatted = "export const value = { name: 'hello', items: [1, 2] };\n";
  assert.equal(f.invoke(['show', 'HEAD:new file.ts']).stdout, formatted);
  assert.equal(readFileSync(join(f.dir, 'new file.ts'), 'utf8'), formatted);
  assert.equal(
    readFileSync(join(f.dir, 'hello.txt'), 'utf8'),
    'keep this unstaged\n'
  );
  assert.equal(f.invoke(['show', 'HEAD:hello.txt']).stdout, 'safe\n');
});

test('partial staging blocks before changing any file or index entry', (t) => {
  const f = fixture(t);
  const staged = 'export const value={count:1}';
  const unstaged = 'export const value={count:2}';
  f.write('a.ts', staged);
  f.write('z.ts', staged);
  assert.equal(f.invoke(['add', '--', 'a.ts', 'z.ts']).status, 0);
  f.write('z.ts', unstaged);
  const before = f.invoke(['diff', '--cached']).stdout;
  const result = f.invoke(['commit', '-m', '부분 스테이징 검사']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Partial staging/);
  assert.equal(f.invoke(['diff', '--cached']).stdout, before);
  assert.equal(readFileSync(join(f.dir, 'a.ts'), 'utf8'), staged);
  assert.equal(readFileSync(join(f.dir, 'z.ts'), 'utf8'), unstaged);
});

test('syntax errors block without modifying previously planned files', (t) => {
  const f = fixture(t);
  const text = 'export const value={count:1}';
  f.write('a.ts', text);
  f.write('z.ts', 'export const broken = {');
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Prettier failed/);
  assert.equal(readFileSync(join(f.dir, 'a.ts'), 'utf8'), text);
});

test('ignored and unsupported files remain byte-identical', (t) => {
  const f = fixture(t);
  f.write('.prettierignore', 'ignored.ts\n');
  const ignored = 'export const value={count:1}';
  f.write('ignored.ts', ignored);
  f.write('query.sql', 'SELECT   1;');
  const result = f.commit();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.invoke(['show', 'HEAD:ignored.ts']).stdout, ignored);
  assert.equal(f.invoke(['show', 'HEAD:query.sql']).stdout, 'SELECT   1;');
});
