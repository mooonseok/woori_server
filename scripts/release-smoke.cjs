// Runs INSIDE a freshly built release image (mounted read-only by
// scripts/release-image.mjs, started with --network none). Checks the image
// holds exactly the exported source, runs as the non-root node user on amd64,
// ships no private configuration files, and that the API boots in production
// mode with synthetic settings and reports the expected release. Prints
// PASS lines and one JSON summary; never prints configuration values.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const manifest = JSON.parse(
  fs.readFileSync('/verification/source-manifest.json', 'utf8')
);
const expected = process.env.EXPECT_RELEASE || null;
let checked = 0;
for (const [name, hash] of Object.entries(manifest.files)) {
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(`/app/${name}`))
    .digest('hex');
  assert.equal(actual, hash, `source differs: ${name}`);
  checked++;
}
assert.equal(process.arch, 'x64', 'image is not amd64');
assert.equal(process.getuid(), 1000, 'image does not run as node (uid 1000)');
// Private settings and key material anywhere in the copied source (dependencies
// and build output excluded). A public CA certificate may only live in deploy/.
const privateFiles = [];
const walk = (dir, rel) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name))
        walk(`${dir}/${entry.name}`, path);
    } else if (
      /^\.env(\..*)?$/.test(entry.name) ||
      /\.(pem|key|p12|pfx)$/i.test(entry.name) ||
      (/\.crt$/i.test(entry.name) && !path.startsWith('deploy/'))
    )
      privateFiles.push(path);
  }
};
walk('/app', '');
assert.deepEqual(privateFiles, [], 'private configuration files in image');
console.log(
  `PASS: ${checked} source files match, amd64, non-root, no private files`
);
// The daily R2 backup runs from this image too: without settings it must load
// its compiled helpers and SDK, then stop with the usage exit code 2.
const backup = require('node:child_process').spawnSync(
  process.execPath,
  ['scripts/r2-backup.mjs'],
  { cwd: '/app', env: { PATH: process.env.PATH }, encoding: 'utf8' }
);
assert.equal(backup.status, 2, `backup script exit ${backup.status}`);
assert.match(backup.stderr, /Set R2_ACCOUNT_ID/, 'backup script did not load');
console.log('PASS: backup script loads and refuses to run without settings');

const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PORT: '3001',
  TRUST_PROXY_HOPS: '1',
  WEB_ORIGIN: 'https://woori.example',
  ADMIN_WEB_ORIGIN: 'https://admin.woori.example',
  CORS_ALLOWED_ORIGINS: 'https://woori.example,https://admin.woori.example',
  DATABASE_URL: 'postgresql://smoke@db.invalid:5432/unused',
  MAIL_MODE: 'resend',
  RESEND_API_KEY: 'smoke-only',
  MAIL_FROM: '우리 <no-reply@mail.woori.example>',
  MAIL_OUTBOX_KEY: crypto.randomBytes(32).toString('base64'),
  ADMIN_TOTP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  R2_ACCOUNT_ID: '0'.repeat(32),
  R2_ACCESS_KEY_ID: 'smoke-only',
  R2_SECRET_ACCESS_KEY: 'smoke-only',
  R2_BUCKET: 'smoke-unused',
  WOORI_RELEASE: process.env.WOORI_RELEASE ?? '',
};
const child = spawn(process.execPath, ['dist/src/main.js'], {
  cwd: '/app',
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
const get = (path) =>
  fetch(`http://127.0.0.1:3001${path}`, { signal: AbortSignal.timeout(2000) });

(async () => {
  try {
    let health;
    for (let attempt = 0; attempt < 60 && !health; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`API exited during start:\n${output}`);
      try {
        const response = await get('/healthz');
        if (response.ok) health = await response.json();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    assert.equal(health?.status, 'alive', 'API /healthz did not answer');
    assert.equal(health.release, expected, 'API release does not match');
    // No network: the DB is unreachable, so readiness must refuse.
    assert.equal((await get('/readyz')).status, 503, 'readyz without a DB');
    console.log(
      'PASS: production-mode API boots, /healthz reports the release, /readyz 503 without a DB'
    );
    console.log(
      JSON.stringify({ smoke: 'pass', sourceFiles: checked, release: expected })
    );
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }
})();
