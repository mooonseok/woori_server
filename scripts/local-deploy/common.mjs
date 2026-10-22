// Local terminal deployment helpers. Never load production credentials while
// installing dependencies or building the disposable release checkout.
import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const base = join(homedir(), '.woori', 'deploy');
export const expand = (p) =>
  p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p);
export const log = (text) => console.log(`[배포] ${text}`);
export function assert(ok, message) {
  if (!ok) throw new Error(message);
}
export function buildEnv(extra = {}) {
  const env = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SSH_AUTH_SOCK',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'XDG_RUNTIME_DIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}
export async function run(
  command,
  args,
  { cwd, env = buildEnv(), capture = false, input, allowed = [0] } = {}
) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [
        input === undefined ? 'ignore' : 'pipe',
        capture ? 'pipe' : 'inherit',
        capture ? 'pipe' : 'inherit',
      ],
    });
    let out = '',
      err = '';
    if (capture) {
      child.stdout.on('data', (data) => {
        out += data;
      });
      child.stderr.on('data', (data) => {
        err += data;
      });
    }
    const interrupt = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    };
    child.on('error', () => {
      cleanup();
      reject(new Error(`${command} 실행 불가: 설치와 PATH를 확인하세요.`));
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (signal || !allowed.includes(code)) {
        // Never interpolate arguments; redact known credentials from captured errors.
        if (capture && err) {
          for (const [key, value] of Object.entries(env)) {
            if (/TOKEN|SECRET|PASSWORD|SSH_KEY|DATABASE_URL/.test(key) && value)
              err = err.split(value).join('[REDACTED]');
          }
          console.error(err.slice(-3000));
        }
        reject(
          new Error(
            `${command} 실패 (종료 ${code ?? signal}). 배포를 중단했습니다.`
          )
        );
      } else resolvePromise({ code, out: out.trim(), err: err.trim() });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
export function privateEnv(path) {
  const file = expand(path);
  const s = statSync(file);
  assert(
    s.isFile() && (s.mode & 0o077) === 0 && s.uid === process.getuid(),
    `${file}: 현재 사용자 소유의 600 권한 파일이어야 합니다.`
  );
  return parseEnv(readFileSync(file, 'utf8'));
}
export function config(kind) {
  const file = join(base, `${kind}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} 설정이 없습니다. pnpm deploy:setup을 실행하세요.`);
  }
}
export function acquire(kind) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const path = join(base, `${kind}.lock`);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new Error(
      `${path}: 다른 배포가 실행 중입니다. 실행 프로세스가 없는 경우에만 이 잠금 폴더를 제거하세요.`
    );
  }
  writeFileSync(join(path, 'pid'), String(process.pid), { mode: 0o600 });
  return () => rmSync(path, { recursive: true, force: true });
}
export async function git(root, args) {
  return (await run('git', args, { cwd: root, capture: true })).out;
}
export async function target(root, repository) {
  assert(
    Number(process.versions.node.split('.')[0]) === 24,
    'Node 24가 필요합니다. nvm use를 실행하세요.'
  );
  const remote = await git(root, ['remote', 'get-url', 'origin']);
  assert(
    [
      `https://github.com/${repository}.git`,
      `https://github.com/${repository}`,
      `git@github.com:${repository}.git`,
    ].includes(remote),
    '예상한 GitHub 저장소의 origin이 아닙니다.'
  );
  await git(root, ['fetch', '--quiet', 'origin', 'develop']);
  const head = (
    await git(root, ['ls-remote', 'origin', 'refs/heads/develop'])
  ).split(/\s/)[0];
  assert(
    /^[a-f0-9]{40}$/.test(head),
    '원격 develop 커밋을 확인할 수 없습니다.'
  );
  return { head, remote };
}
export async function current(root, head) {
  const now = (
    await git(root, ['ls-remote', 'origin', 'refs/heads/develop'])
  ).split(/\s/)[0];
  assert(
    now === head,
    '빌드 중 develop이 변경됐습니다. 최신 커밋으로 다시 실행하세요.'
  );
}
export async function noActions(repository) {
  const { out } = await run(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repository,
      '--workflow',
      'deploy.yml',
      '--limit',
      '50',
      '--json',
      'status',
    ],
    { capture: true }
  );
  assert(
    JSON.parse(out).every((r) => r.status === 'completed'),
    'GitHub Deploy 실행/승인 대기가 있습니다. 완료하거나 취소한 뒤 로컬 배포하세요.'
  );
}
export async function checkout(root, remote, head) {
  const temp = mkdtempSync(join(tmpdir(), 'woori-terminal-'));
  const dir = join(temp, 'source');
  try {
    await run('git', [
      'clone',
      '--quiet',
      '--no-hardlinks',
      '--no-checkout',
      root,
      dir,
    ]);
    await git(dir, ['remote', 'set-url', 'origin', remote]);
    await git(dir, ['fetch', '--quiet', 'origin', 'develop']);
    await git(dir, ['checkout', '--quiet', '--detach', head]);
    return {
      dir,
      cleanup: () => rmSync(temp, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
export function fields(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[a-z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );
}
