// What .github/workflows/deploy.yml must keep, checked on the parsed file and
// on deliberate mutations of it: wiring that, if broken, deploys the wrong
// commit, skips a check, approval or rollback, or hands secrets or the DB
// approval to dependency code. Plus scripts/deploy-plan.mjs on a scratch repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repo } from './deploy-harness';

type Yaml = string | number | null | Yaml[] | { [key: string]: Yaml };
type Job = Record<string, any>;

// A reader for the YAML subset the workflows use: block mappings and
// sequences, plain, quoted and flow scalars, | and > blocks, comments, and
// scalar anchors/aliases (&name / *name).
export function parseYaml(source: string): any {
  const lines = source.split('\n');
  const anchors: Record<string, Yaml> = {};
  let i = 0;
  const indent = (line: string) => line.length - line.trimStart().length;
  const next = () => {
    while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
    return lines[i];
  };
  const keyLine = /^\s*([\w$.-]+):(?: (.*))?$/;
  const scalar = (text: string): Yaml => {
    let value = text.trim().replace(/\s+#.*$/, '');
    const anchor = /^&([\w-]+) (.*)$/.exec(value);
    if (anchor) {
      const v = scalar(anchor[2]);
      anchors[anchor[1]] = v;
      return v;
    }
    const alias = /^\*([\w-]+)$/.exec(value);
    if (alias) {
      if (!(alias[1] in anchors)) throw new Error(`unknown anchor ${alias[1]}`);
      return anchors[alias[1]];
    }
    if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith('['))
      return value
        .slice(1, -1)
        .split(',')
        .map((item) => scalar(item))
        .filter((item) => item !== '');
    return value;
  };
  const value = (rest: string, own: number): Yaml => {
    if (/^[|>][-+]?$/.test(rest)) {
      const body: string[] = [];
      while (i < lines.length && (!lines[i].trim() || indent(lines[i]) > own))
        body.push(lines[i++]);
      while (body.length && !body.at(-1)!.trim()) body.pop();
      const pad = Math.min(...body.filter((l) => l.trim()).map(indent));
      const text = body.map((l) => l.slice(pad));
      return rest[0] === '|'
        ? text.join('\n')
        : text.map((l) => l.trim()).join(' ');
    }
    if (rest) return scalar(rest);
    const line = next();
    if (line === undefined || indent(line) <= own) return null;
    if (/^\s*-( |$)/.test(line) || keyLine.test(line))
      return block(indent(line));
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim() && indent(lines[i]) > own)
      parts.push(lines[i++].trim());
    return scalar(parts.join(' '));
  };
  const block = (at: number): Yaml => {
    if (/^\s*-( |$)/.test(lines[i])) {
      const list: Yaml[] = [];
      while (
        next() !== undefined &&
        indent(lines[i]) === at &&
        /^\s*-( |$)/.test(lines[i])
      ) {
        const rest = lines[i].slice(at + 1).trimStart();
        if (keyLine.test(rest)) {
          lines[i] = ' '.repeat(at + 2) + rest;
          list.push(block(at + 2));
        } else {
          i++;
          list.push(scalar(rest));
        }
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (
      next() !== undefined &&
      indent(lines[i]) === at &&
      !/^\s*-( |$)/.test(lines[i])
    ) {
      const match = keyLine.exec(lines[i]);
      if (!match) throw new Error(`Unreadable YAML line ${i + 1}: ${lines[i]}`);
      i++;
      map[match[1]] = value((match[2] ?? '').trim(), at);
    }
    return map;
  };
  next();
  return block(indent(lines[i]));
}

const secretUse = /secrets\.|github\.token/;
const stepNames = (job: Job) =>
  (job.steps ?? []).map((s: Job) => s.name ?? s.uses ?? s.run);

export function deployWorkflowProblems(text: string): string[] {
  let wf: any;
  try {
    wf = parseYaml(text);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems: string[] = [];
  const check = (ok: unknown, message: string) => {
    if (!ok) problems.push(message);
  };
  const jobs: Record<string, Job> = wf.jobs ?? {};
  const {
    target = {},
    quality = {},
    build = {},
    prepare = {},
    deploy = {},
    rollback = {},
  } = jobs;
  const approve = jobs['approve-db'] ?? {};
  check(
    isDeepStrictEqual(wf.on?.push?.branches, [wf.env?.DEPLOY_BRANCH]) &&
      wf.env?.DEPLOY_BRANCH === 'main',
    'on.push.branches must be exactly env.DEPLOY_BRANCH (main)'
  );
  check(!('workflow_run' in (wf.on ?? {})), 'no workflow_run trigger');
  check(
    wf.concurrency?.['cancel-in-progress'] === 'false' && wf.concurrency?.group,
    'one deployment at a time, never cancelled'
  );
  check(
    quality.uses === './.github/workflows/quality.yml' &&
      quality.with?.ref === '${{ needs.target.outputs.sha }}',
    'Quality runs quality.yml on the deployed commit'
  );
  check(
    isDeepStrictEqual(build.needs, ['target', 'quality']) && !build.environment,
    'build needs Quality and has no environment'
  );
  // The build job runs dependency code: no secrets, and the token only in the
  // step that runs release-image.mjs (git ls-remote).
  check(!/secrets\./.test(JSON.stringify(build)), 'build must not see secrets');
  const tokenSteps = (build.steps ?? []).filter((s: Job) =>
    /github\.token/.test(JSON.stringify(s))
  );
  check(
    tokenSteps.length === 1 &&
      /release-image\.mjs/.test(tokenSteps[0].run ?? ''),
    'build passes the token only to the release-image step'
  );
  check(
    !secretUse.test(JSON.stringify(quality)),
    'quality must not see secrets'
  );
  for (const [name, job] of Object.entries(jobs))
    for (const step of job.steps ?? [])
      if (step.uses && !step.uses.startsWith('./'))
        check(
          /@[0-9a-f]{40}$/.test(step.uses),
          `${name}: ${step.uses} must be pinned to a commit SHA`
        );
  // Secrets only in the SSH settings steps of jobs in the production environment.
  for (const [name, job] of Object.entries(jobs)) {
    const secretSteps = (job.steps ?? []).filter((s: Job) =>
      /secrets\./.test(JSON.stringify(s))
    );
    if (!secretSteps.length) continue;
    check(
      (job.environment === 'production' ||
        job.environment?.name === 'production') &&
        secretSteps.every((s: Job) => s.name === 'SSH settings'),
      `${name}: secrets only in the SSH settings step of a production job`
    );
  }
  check(
    prepare.environment === 'production' &&
      isDeepStrictEqual(prepare.needs, ['target', 'build']) &&
      /deploy-release\.sh prepare/.test(JSON.stringify(prepare.steps)),
    'prepare runs on the production hosts after build'
  );
  check(
    approve.environment === 'production-migrations' &&
      /needs\.prepare\.outputs\.plan_changes == 'true'/.test(
        approve.if ?? ''
      ) &&
      /vars\.DEPLOY_DB_APPROVAL != 'dispatch'/.test(approve.if ?? ''),
    'approve-db gates on the host plan in production-migrations'
  );
  check(
    deploy.environment?.name === 'production' &&
      ['prepare', 'approve-db'].every((n) => deploy.needs?.includes(n)) &&
      /needs\.prepare\.result == 'success'/.test(deploy.if ?? '') &&
      /needs\.approve-db\.result == 'success' \|\| needs\.approve-db\.result == 'skipped'/.test(
        deploy.if ?? ''
      ) &&
      /!cancelled\(\)/.test(deploy.if ?? ''),
    'deploy needs prepare and the approval (or no approval needed)'
  );
  const steps: Job[] = deploy.steps ?? [];
  const at = (name: string) => steps.findIndex((s) => s.name === name);
  const approval = steps[at('DB change approval')] ?? {};
  const approvalText = JSON.stringify(approval);
  check(
    /actions\/runs\/\$GITHUB_RUN_ID\/approvals/.test(approval.run ?? '') &&
      /production-migrations/.test(approval.run ?? '') &&
      approval.env?.APPROVAL_MODE === '${{ vars.DEPLOY_DB_APPROVAL }}' &&
      approval.env?.DISPATCH_APPROVAL === '${{ inputs.approve_db_changes }}' &&
      !/needs\.build/.test(approvalText),
    'the DB approval comes from the run history, vars and inputs, never from build'
  );
  check(
    deploy.permissions?.actions === 'read',
    'deploy can read the run approval history'
  );
  const order = [
    'DB change approval',
    'SSH settings',
    'Deploy',
    'Reconcile hosts',
    'Remove SSH key',
  ];
  check(
    order.every((n) => at(n) >= 0) &&
      order.every((n, k) => k === 0 || at(order[k - 1]) < at(n)),
    `deploy steps must run as ${order.join(' -> ')}`
  );
  const deployStep = steps[at('Deploy')] ?? {};
  check(
    deployStep.env?.DEPLOY_DB_APPROVAL ===
      '${{ steps.approval.outputs.value }}' &&
      /deploy-release\.sh deploy/.test(deployStep.run ?? ''),
    'Deploy passes only the checked approval value'
  );
  const reconcile = steps[at('Reconcile hosts')] ?? {};
  check(
    /^always\(\)/.test(reconcile.if ?? '') &&
      /deploy-release\.sh reconcile/.test(reconcile.run ?? ''),
    'reconcile runs after success, failure and cancel'
  );
  check(
    (steps[at('Remove SSH key')] ?? {}).if === 'always()',
    'the SSH key is always removed'
  );
  check(
    /needs\.target\.outputs\.mode == 'rollback'/.test(rollback.if ?? '') &&
      /deploy-release\.sh rollback-to/.test(JSON.stringify(rollback.steps)) &&
      stepNames(rollback).includes('Reconcile hosts') &&
      !rollback.needs?.includes?.('build'),
    'fast rollback skips build and still reconciles'
  );
  check(
    /needs\.target\.outputs\.mode == 'deploy'/.test(quality.if ?? ''),
    'Quality runs for deployments'
  );
  check(
    /merge-base --is-ancestor/.test(JSON.stringify(target.steps)) &&
      /refs\/heads\/\$DEPLOY_BRANCH/.test(JSON.stringify(target.steps)),
    'target accepts only commits of the deploy branch'
  );
  return problems;
}

test('deploy.yml wiring holds and each guarded mutation is caught', () => {
  const deploy = readFileSync(
    join(repo, '.github/workflows/deploy.yml'),
    'utf8'
  );
  assert.deepEqual(deployWorkflowProblems(deploy), []);
  const quality = readFileSync(
    join(repo, '.github/workflows/quality.yml'),
    'utf8'
  );
  assert.match(quality, /workflow_call:/);
  assert.match(quality, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.doesNotMatch(quality, /uses: [^\n]*@v\d/);
  const mutations: Record<string, [string, RegExp]> = {
    'reconcile removed': [
      deploy.slice(0, deploy.indexOf('      - name: Reconcile hosts')) +
        deploy.slice(
          deploy.indexOf(
            '      - name: Remove SSH key',
            deploy.indexOf('      - name: Reconcile hosts')
          )
        ),
      /deploy steps must run as|reconcile runs/,
    ],
    'reconcile only on success': [
      deploy.replace(
        "        if: always() && steps.ssh.outcome == 'success'",
        '        if: success()'
      ),
      /reconcile runs/,
    ],
    'approval taken from build output': [
      deploy.slice(
        0,
        deploy.lastIndexOf('PLAN_HASH: ${{ needs.prepare.outputs.plan_hash }}')
      ) +
        'PLAN_HASH: ${{ needs.build.outputs.meta }}' +
        deploy.slice(
          deploy.lastIndexOf(
            'PLAN_HASH: ${{ needs.prepare.outputs.plan_hash }}'
          ) + 'PLAN_HASH: ${{ needs.prepare.outputs.plan_hash }}'.length
        ),
      /never from build/,
    ],
    'approvals API check removed': [
      deploy.replace(
        'actions/runs/$GITHUB_RUN_ID/approvals',
        'actions/runs/$GITHUB_RUN_ID'
      ),
      /never from build/,
    ],
    'a secret in the build job': [
      deploy.replace(
        '      - run: pnpm build\n',
        '      - run: pnpm build\n      - run: echo "${{ secrets.DEPLOY_SSH_KEY }}" > key\n'
      ),
      /build must not see secrets/,
    ],
    'unpinned action': [
      deploy.replace(
        'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4',
        'actions/download-artifact@v4'
      ),
      /must be pinned/,
    ],
    'deploy without the approval job': [
      deploy.replace(
        '    needs: [target, build, prepare, approve-db]',
        '    needs: [target, build, prepare]'
      ),
      /deploy needs prepare and the approval/,
    ],
    'trigger branch drift': [
      deploy.replace(
        'branches: [&deploy_branch main]',
        'branches: [develop]\n    tags: [&deploy_branch main]'
      ),
      /on\.push\.branches/,
    ],
    'cancel in progress': [
      deploy.replace(
        '  cancel-in-progress: false',
        '  cancel-in-progress: true'
      ),
      /never cancelled/,
    ],
  };
  for (const [name, [mutated, expected]] of Object.entries(mutations)) {
    assert.notEqual(mutated, deploy, `${name}: the mutation applies`);
    const problems = deployWorkflowProblems(mutated);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${name}: ${problems.join(' | ') || 'not caught'}`
    );
  }
});

test('deploy-plan summarises from git only and never blocks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'woori-deploy-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'plan@example.invalid');
  git('config', 'user.name', 'Plan Fixture');
  git('config', 'commit.gpgsign', 'false');
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write(
    'prisma/migrations/20261101000000_a/migration.sql',
    'CREATE TABLE woori.a (id INT);\n'
  );
  write(
    'prisma/runtime-grants.sql',
    'GRANT USAGE ON SCHEMA woori TO woori_api;\n'
  );
  git('add', '.');
  git('commit', '-q', '-m', 'a');
  const base = git('rev-parse', 'HEAD');
  write(
    'prisma/migrations/20261102000000_b/migration.sql',
    'UPDATE woori.a SET id = 1;\nALTER TABLE woori.a ADD COLUMN b TEXT;\n'
  );
  git('add', '.');
  git('commit', '-q', '-m', 'b');
  const head = git('rev-parse', 'HEAD');
  const outputs = join(dir, 'out');
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(repo, 'scripts/deploy-plan.mjs'), ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputs,
          GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        },
      }
    );
  const added = run('--target', head, '--deployed', base);
  assert.equal(added.status, 0, added.stderr);
  const plan = JSON.parse(added.stdout);
  assert.deepEqual(plan.added, ['20261102000000_b']);
  assert.deepEqual(
    plan.manual.map((m: { kind: string }) => m.kind),
    ['update woori.a']
  );
  assert.match(readFileSync(outputs, 'utf8'), /^db_changes=true$/m);
  assert.match(
    readFileSync(join(dir, 'summary'), 'utf8'),
    /자동 적용 불가 문장[^\n]*20261102000000_b/
  );
  const same = JSON.parse(run('--target', head, '--deployed', head).stdout);
  assert.equal(same.dbChanges, false);
  const unknown = JSON.parse(
    run('--target', head, '--deployed', 'unknown').stdout
  );
  assert.deepEqual(unknown.reasons, ['running-release-unknown']);
  for (const bad of [
    ['--target', 'HEAD'],
    ['--target', head, '--deployed', 'x'],
    ['--approved', 'x'],
  ])
    assert.equal(run(...bad).status, 2, bad.join(' '));
});
