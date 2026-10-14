import 'reflect-metadata';
import { PushDispatchService } from './push/push-dispatch.service';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { startupFailure } from '../common/configurations/startup-diagnostics';
import { MediaCleanupService } from './media-cleanup/media-cleanup.service';
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
  if (process.argv.includes('--check')) {
    // Construction only: never connects to DB/R2 in the bootstrap check.
    console.log(
      JSON.stringify({
        service: 'woori-worker',
        status: 'bootstrap',
        jobsReady: true,
      })
    );
    await app.close();
    return;
  }
  const cleanup = app.get(MediaCleanupService);
  const push = app.get(PushDispatchService);
  const runPass = async () => {
    const results = await Promise.allSettled([
      cleanup.runBatch(),
      push.runBatch(),
    ]);
    for (const [index, result] of results.entries()) {
      const job = index === 0 ? 'media-cleanup' : 'web-push';
      if (result.status === 'fulfilled') {
        if (
          Object.values(result.value).some(
            (count) => typeof count === 'number' && count > 0
          )
        )
          console.log(
            JSON.stringify({ service: 'woori-worker', job, ...result.value })
          );
      } else console.error(`Worker ${job} pass failed; it will be retried.`);
    }
    return results.every((result) => result.status === 'fulfilled');
  };
  if (process.argv.includes('--once')) {
    try {
      if (!(await runPass())) process.exitCode = 1;
    } finally {
      await app.close();
    }
    return;
  }
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const poll = async () => {
    try {
      await runPass();
    } finally {
      if (!closing)
        timer = setTimeout(() => {
          inFlight = poll();
        }, 10_000);
    }
  };
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    await inFlight;
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  console.log(
    JSON.stringify({
      service: 'woori-worker',
      status: 'polling',
      jobsReady: true,
    })
  );
  inFlight = poll();
}
void main().catch((error: unknown) => {
  console.error(`Worker bootstrap failed: ${startupFailure(error)}`);
  process.exitCode = 1;
});
