import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const cwd = process.cwd();
const read = (path) => readFileSync(join(cwd, path), 'utf8');
const assert = (value, message) => {
  if (!value) throw new Error(message);
};
try {
  for (const file of ['AGENTS.md', 'CLAUDE.md'])
    assert(
      read(file).trimEnd().split('\n').length <= 200,
      `${file}: exceeds 200 lines`
    );
  assert(
    read('CLAUDE.md').includes('@AGENTS.md'),
    'Missing common instructions import'
  );
  for (const name of readdirSync(join(cwd, '.claude/skills'))) {
    const canonical = `.claude/skills/${name}/SKILL.md`;
    const connected = `.agents/skills/${name}/SKILL.md`;
    assert(
      realpathSync(join(cwd, canonical)) === realpathSync(join(cwd, connected)),
      `Skill connection drift: ${name}`
    );
    const text = read(canonical);
    assert(
      text.startsWith('---\n') &&
        text.includes(`name: ${name}\n`) &&
        /^description: .+/m.test(text),
      `Invalid skill metadata: ${name}`
    );
    assert(text.includes('출처:'), `Missing skill provenance: ${name}`);
  }
  for (const name of readdirSync(join(cwd, '.claude/rules')))
    assert(
      /^paths:\n/m.test(read(`.claude/rules/${name}`)),
      `Missing rule scope: ${name}`
    );
  for (const source of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(read(source));
    assert(config.hooks.PreToolUse.length > 0, `Missing tool hook: ${source}`);
    for (const group of config.hooks.PreToolUse)
      for (const hook of group.hooks) {
        assert(
          hook.type === 'command' && hook.timeout > 0 && !hook.async,
          `Invalid blocking hook: ${source}`
        );
      }
  }
  for (const dir of ['.claude/hooks', '.codex/hooks']) {
    assert(
      read(`${dir}/pre-tool-use.mjs`).includes(
        '../../scripts/policy/tool-guard.mjs'
      ),
      `Wrong shared hook target: ${dir}`
    );
  }
  for (const name of ['woori-commit', 'woori-deploy']) {
    assert(
      read(`.claude/skills/${name}/SKILL.md`).includes(
        'disable-model-invocation: true'
      ),
      `Claude manual invocation missing: ${name}`
    );
    assert(
      read(`.claude/skills/${name}/agents/openai.yaml`).includes(
        'allow_implicit_invocation: false'
      ),
      `Codex manual invocation missing: ${name}`
    );
  }
  const registry = JSON.parse(read('scripts/policy/agents.json'));
  for (const [name, spec] of Object.entries(registry)) {
    assert(
      read(`.claude/agents/${name}.md`).includes(spec.instructions),
      `Claude agent drift: ${name}`
    );
    assert(
      read(`.codex/agents/${name}.toml`).includes(spec.instructions),
      `Codex agent drift: ${name}`
    );
  }
  const provenance = JSON.parse(read('scripts/policy/sources.json'));
  assert(provenance.length > 0, 'Missing provenance');
  for (const file of ['pre-commit', 'commit-msg', 'pre-push'])
    assert(
      read(`.githooks/${file}`).includes('scripts/policy/run-node.sh'),
      `Broken Git hook: ${file}`
    );
  // Validate TOML with the installed Python parser; never infer agent loading from Markdown alone.
  const toml = spawnSync(
    'python3',
    [
      '-c',
      'import pathlib,tomllib; [tomllib.loads(p.read_text()) for p in pathlib.Path(".codex/agents").glob("*.toml")]',
    ],
    { cwd, encoding: 'utf8' }
  );
  assert(
    toml.status === 0,
    'Agent TOML parsing failed (Python 3.11+ required).'
  );
  for (const name of readdirSync(join(cwd, '.agents/skills')))
    assert(
      !relative(
        cwd,
        realpathSync(join(cwd, '.agents/skills', name))
      ).startsWith('..'),
      'External skill link forbidden'
    );
  assert(
    existsSync(resolve(cwd, '.github/workflows/quality.yml')),
    'Missing CI workflow'
  );
  console.log(
    'Policy instructions, skills, agent parity, and hook registration passed.'
  );
} catch (error) {
  console.error(`[woori policy] ${error.message}`);
  process.exitCode = 1;
}
