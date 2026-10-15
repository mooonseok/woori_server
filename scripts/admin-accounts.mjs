import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// Owner-connection admin account maintenance (create, reset-mfa, disable,
// enable). Uses MIGRATION_DATABASE_URL only; the runtime API role cannot do
// this. Passwords come from a no-echo TTY prompt (twice) or a single line on
// stdin with --password-stdin, never from argv. Nothing secret is printed.
const require = createRequire(import.meta.url);
const compiled = fileURLToPath(
  new URL('../dist/src/admin/cli/admin-account-commands.js', import.meta.url)
);
if (!existsSync(compiled)) {
  console.error('먼저 pnpm build를 실행하세요 (dist가 필요합니다).');
  process.exit(1);
}
require('reflect-metadata');
const cli = require(compiled);

function readStdinLine() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) reject(new cli.AdminCliError('INVALID_PASSWORD'));
    });
    process.stdin.on('end', () => {
      const line = data.replace(/\r?\n$/, '');
      if (/[\r\n]/.test(line))
        reject(new cli.AdminCliError('INVALID_PASSWORD'));
      else resolve(line);
    });
    process.stdin.on('error', () =>
      reject(new cli.AdminCliError('PASSWORD_INPUT_REQUIRED'))
    );
  });
}
function promptHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function')
    return Promise.reject(new cli.AdminCliError('PASSWORD_INPUT_REQUIRED'));
  return new Promise((resolve, reject) => {
    let value = '';
    process.stderr.write(label);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const done = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003' || char === '\u0004')
          return done(new cli.AdminCliError('PASSWORD_INPUT_REQUIRED'));
        if (char === '\u007f' || char === '\b')
          value = Array.from(value).slice(0, -1).join('');
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function readPassword(options) {
  if (options.passwordStdin)
    return cli.validateAdminPassword(await readStdinLine());
  const first = cli.validateAdminPassword(
    await promptHidden('새 관리자 비밀번호: ')
  );
  const second = await promptHidden('비밀번호 확인: ');
  if (first !== second) throw new cli.AdminCliError('PASSWORD_MISMATCH');
  return first;
}

let client;
try {
  const options = cli.parseAdminCliArgs(process.argv.slice(2));
  const database = cli.targetDatabaseName(process.env.MIGRATION_DATABASE_URL);
  if (options.confirmDatabase !== database)
    throw new cli.AdminCliError('DATABASE_NOT_CONFIRMED');
  const password =
    options.command === 'create' ? await readPassword(options) : undefined;
  client = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await client.connect();
  if (options.command === 'create') {
    const created = await cli.createAdminAccount(client, {
      username: options.username,
      displayName: options.displayName,
      password,
    });
    console.log(JSON.stringify({ id: created.id, username: created.username }));
  } else if (options.command === 'reset-mfa') {
    const result = await cli.resetAdminMfa(client, options.username);
    console.log(
      JSON.stringify({
        id: result.id,
        username: options.username,
        revokedSessions: result.revokedSessions,
      })
    );
  } else {
    const result = await cli.setAdminStatus(
      client,
      options.username,
      options.command === 'enable' ? 'ACTIVE' : 'DISABLED'
    );
    console.log(
      JSON.stringify({
        id: result.id,
        username: options.username,
        status: result.status,
        revokedSessions: result.revokedSessions,
      })
    );
  }
} catch (error) {
  console.error(cli.adminCliErrorMessage(error));
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => undefined);
}
