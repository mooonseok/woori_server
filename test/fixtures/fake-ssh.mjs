// Test double for ssh as deploy/lightsail/deploy-release.sh uses it
// (test/deploy-release.test.ts): `ssh [-n] -F <config> <host> <command>` runs
// the host's forced command (woori-deploy.sh ssh) against that host's fake
// docker, passing stdin through. FAKE_SSH_HOSTS (JSON) maps host -> env;
// FAKE_SSH_FAULTS names a JSON list of one-shot faults:
//   { "host": "woori-api", "command": "deploy-api", "when": "before" | "during" | "down" }
// before: exit 255 without running; during: run it, drop the connection
// (exit 255) once the job id is printed — the job keeps running on the host;
// down: this and every later call to that host fail with 255.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
let i = 0;
while (i < args.length && args[i].startsWith('-'))
  i += args[i] === '-F' || args[i] === '-o' ? 2 : 1;
const host = args[i];
const command = args.slice(i + 1).join(' ');
const hosts = JSON.parse(process.env.FAKE_SSH_HOSTS ?? '{}');
const target = hosts[host];
if (!target) {
  process.stderr.write(`ssh: Could not resolve hostname ${host}\n`);
  process.exit(255);
}
const faultsFile = process.env.FAKE_SSH_FAULTS;
const faults =
  faultsFile && existsSync(faultsFile)
    ? JSON.parse(readFileSync(faultsFile, 'utf8'))
    : [];
const word = command.split(' ')[0];
const down = faults.find(
  (f) => f.host === host && f.when === 'down' && f.active
);
if (down) process.exit(255);
const index = faults.findIndex(
  (f) => f.host === host && f.command === word && !f.used
);
const fault = index >= 0 ? faults[index] : null;
if (fault) {
  fault.used = true;
  if (fault.when === 'down') fault.active = true;
  writeFileSync(faultsFile, JSON.stringify(faults));
  if (fault.when === 'before' || fault.when === 'down') process.exit(255);
}
const child = spawn('/bin/bash', [target.script, 'ssh'], {
  env: { ...process.env, ...target.env, SSH_ORIGINAL_COMMAND: command },
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stderr.pipe(process.stderr);
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (fault?.when === 'during' && /job=/.test(chunk.toString())) {
    child.kill('SIGKILL');
    process.exit(255);
  }
});
child.on('close', (code) => process.exit(code ?? 255));
