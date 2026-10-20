import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('cleanup worker exits cleanly on SIGTERM even when DB is unavailable', async () => {
  const worker = spawn(
    process.execPath,
    [path.resolve(__dirname, '../src/worker/main.js')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: '', WOORI_RELEASE: 'b'.repeat(40) },
    }
  );
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 5000);
  let output = '';
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    worker.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('"status":"polling"')) worker.kill('SIGTERM');
    });
    const result = await exit;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    const started = JSON.parse(output.trim());
    assert.equal(started.jobsReady, true);
    // The start line names the release so `docker logs` identifies the image.
    assert.equal(started.release, 'b'.repeat(40));
  } finally {
    clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill('SIGKILL');
  }
});
