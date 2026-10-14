import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { MediaCleanupService } from './media-cleanup/media-cleanup.service';
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  if (process.argv.includes('--check')) {
    // Construction only: never connects to DB/R2 in the bootstrap check.
    console.log(JSON.stringify({ service: 'woori-worker', status: 'bootstrap', jobsReady: true }));
    await app.close(); return;
  }
  const cleanup = app.get(MediaCleanupService);
  if (process.argv.includes('--once')) {
    try { console.log(JSON.stringify({ service: 'woori-worker', ...await cleanup.runBatch() })); }
    finally { await app.close(); }
    return;
  }
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const poll = async () => {
    try {
      const result = await cleanup.runBatch();
      if (result.completed || result.retried) console.log(JSON.stringify({ service: 'woori-worker', ...result }));
    } catch { console.error('Media cleanup pass failed; it will be retried.'); }
    finally { if (!closing) timer = setTimeout(() => { inFlight = poll(); }, 10_000); }
  };
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await inFlight;
    await app.close();
  };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
  console.log(JSON.stringify({ service: 'woori-worker', status: 'polling', jobsReady: true }));
  inFlight = poll();
}
void main().catch(() => { console.error('Worker bootstrap failed; check non-secret configuration.'); process.exitCode = 1; });
