import { PhotoProcessingService } from './photo-processing/photo-processing.service';
import 'reflect-metadata';
import { PushDispatchService } from './push/push-dispatch.service';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { startupFailure } from '../common/configurations/startup-diagnostics';
import { MediaCleanupService } from './media-cleanup/media-cleanup.service';
import { GroupCleanupService } from './group-cleanup/group-cleanup.service';
import { checkVideoTools, videoPreset } from '../common/media/video-transcode';
import { assertProductionConfig } from '../common/configurations/production.config';
import { MailOutboxService } from '../domain/mail/mail-outbox';
import {
  WorkerHeartbeatRepository,
  workerInstanceId,
} from './heartbeat/worker-heartbeat.repository';
async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
  if (process.argv.includes('--check')) {
    // Construction only: never connects to DB/R2 in the bootstrap check. Video
    // transcoding (W07-3) needs ffmpeg/ffprobe with libx264 and AAC on PATH (or
    // FFMPEG_PATH/FFPROBE_PATH); a worker without them fails the check.
    const video = await checkVideoTools();
    console.log(
      JSON.stringify({
        service: 'woori-worker',
        status: 'bootstrap',
        jobsReady: true,
        videoReady: video.ready,
        ffmpeg: video.ffmpeg,
        libx264: video.libx264,
        aac: video.aac,
        preset: video.preset,
      })
    );
    if (!video.ready) process.exitCode = 1;
    await app.close();
    return;
  }
  // Production fails fast on missing/unsafe settings (names only, no values).
  assertProductionConfig(process.env, 'worker');
  // An invalid VIDEO_X264_PRESET is a deploy error, not a per-video failure.
  videoPreset(process.env);
  const cleanup = app.get(MediaCleanupService);
  const push = app.get(PushDispatchService);
  const groups = app.get(GroupCleanupService);
  const photos = app.get(PhotoProcessingService);
  const mail = app.get(MailOutboxService);
  const heartbeat = app.get(WorkerHeartbeatRepository);
  const instanceId = workerInstanceId();
  const startedAt = new Date();
  // Without working ffmpeg the worker leaves VIDEO jobs for a worker that has it.
  const videoReady = (await checkVideoTools()).ready;
  // Aborts an in-flight transcode on shutdown; the job is released for retry.
  const shutdown = new AbortController();
  const state = { queuesOk: true, mediaOk: true };
  const report = (job: string, value: Record<string, unknown>) => {
    if (
      Object.values(value).some(
        (count) => typeof count === 'number' && count > 0
      )
    )
      console.log(JSON.stringify({ service: 'woori-worker', job, ...value }));
  };
  // Structured, value-free failure line (provider errors can carry
  // credentials, recipients or URLs, so no message is logged).
  const failed = (job: string) =>
    console.error(
      JSON.stringify({
        service: 'woori-worker',
        job,
        status: 'failed',
        retry: true,
      })
    );
  // Short DB/mail queues: never wait behind a photo/video transcode.
  const runQueues = async () => {
    const jobs = ['media-cleanup', 'web-push', 'group-cleanup', 'mail-outbox'];
    const results = await Promise.allSettled([
      cleanup.runBatch(),
      push.runBatch(),
      groups.runBatch(),
      mail.runBatch(),
    ]);
    for (const [index, result] of results.entries())
      if (result.status === 'fulfilled') report(jobs[index], result.value);
      else failed(jobs[index]);
    state.queuesOk = results.every((result) => result.status === 'fulfilled');
    return state.queuesOk;
  };
  // Photo/video processing: its own loop, at most one video per pass.
  const runMedia = async () => {
    try {
      report(
        'photo-processing',
        await photos.runBatch(2, {
          videos: videoReady,
          signal: shutdown.signal,
        })
      );
      state.mediaOk = true;
    } catch {
      failed('photo-processing');
      state.mediaOk = false;
    }
    return state.mediaOk;
  };
  // Own timer: a long transcode keeps the beat fresh and shows as busyJob.
  let beating: Promise<void> | undefined;
  const beat = () =>
    (beating ??= heartbeat
      .beat(
        instanceId,
        startedAt,
        state.queuesOk && state.mediaOk,
        videoReady,
        photos.busy
      )
      .catch(() => {
        console.error(
          JSON.stringify({
            service: 'woori-worker',
            job: 'heartbeat',
            status: 'failed',
          })
        );
      })
      .finally(() => {
        beating = undefined;
      }));
  if (process.argv.includes('--once')) {
    try {
      const [queuesOk, mediaOk] = await Promise.all([runQueues(), runMedia()]);
      await beat();
      if (!queuesOk || !mediaOk) process.exitCode = 1;
    } finally {
      await app.close();
    }
    return;
  }
  let closing = false;
  // Each loop waits 10 s after its own pass ends; one slow loop never delays
  // the other.
  const loop = (pass: () => Promise<unknown>) => {
    const handle = {
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      inFlight: Promise.resolve(),
    };
    const run = async () => {
      try {
        await pass();
      } finally {
        if (!closing)
          handle.timer = setTimeout(() => {
            handle.inFlight = run();
          }, 10_000);
      }
    };
    handle.inFlight = run();
    return handle;
  };
  const queues = loop(runQueues);
  const media = loop(runMedia);
  // First beat after 15 s, so lastPassOk always reflects finished passes.
  const beatTimer = setInterval(() => void beat(), 15_000);
  // SIGTERM drain: stop scheduling, abort a running transcode (released for
  // retry), let short queue passes finish, record a last beat, then close.
  const stop = async () => {
    if (closing) return;
    closing = true;
    clearInterval(beatTimer);
    clearTimeout(queues.timer);
    clearTimeout(media.timer);
    shutdown.abort();
    await Promise.allSettled([queues.inFlight, media.inFlight]);
    await beating;
    await beat();
    await app.close();
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  console.log(
    JSON.stringify({
      service: 'woori-worker',
      status: 'polling',
      jobsReady: true,
      videoReady,
    })
  );
}
void main().catch((error: unknown) => {
  console.error(`Worker bootstrap failed: ${startupFailure(error)}`);
  process.exitCode = 1;
});
