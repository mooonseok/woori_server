import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ service: 'woori-worker', status: 'bootstrap', jobsReady: false }));
    await app.close(); return;
  }
  console.log(JSON.stringify({ service: 'woori-worker', status: 'idle', jobsReady: false }));
  // No queue polling or object/DB access until adapters and job handlers exist.
  const keepAlive = setInterval(() => {}, 60_000);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; clearInterval(keepAlive); await app.close(); };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
void main().catch(() => { console.error('Worker bootstrap failed.'); process.exitCode = 1; });
