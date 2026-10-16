import { Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { PrismaService } from '../../common/modules/prisma/prisma.service';

// Railway sets RAILWAY_REPLICA_ID per replica; locally host + pid.
export function workerInstanceId(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.RAILWAY_REPLICA_ID?.trim() || `${hostname()}-${process.pid}`;
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

// W07-4 monitoring: the worker upserts its row on its own timer (independent
// of how long a pass or a transcode takes) on the database clock (beatAt), so
// the admin dashboard can tell a stopped worker from a busy one.
export type WorkerBusy = { job: string; since: Date } | null;
@Injectable()
export class WorkerHeartbeatRepository {
  constructor(private readonly prisma: PrismaService) {}
  async beat(
    instanceId: string,
    startedAt: Date,
    lastPassOk: boolean,
    videoReady: boolean,
    busy: WorkerBusy = null
  ) {
    const busyJob = busy?.job.slice(0, 48) ?? null;
    // busySince is stored on the DB clock (like beatAt): the job's elapsed time
    // on this process's clock is subtracted from now(), so the dashboard age
    // never mixes the worker's and the database's clocks.
    const busySeconds = busy
      ? Math.max(0, (Date.now() - busy.since.getTime()) / 1000)
      : null;
    await this.prisma.client.$executeRaw`
      INSERT INTO woori.worker_heartbeats ("instanceId","startedAt","beatAt","lastPassOk","videoReady","busyJob","busySince")
      VALUES (${instanceId},${startedAt},now(),${lastPassOk},${videoReady},${busyJob},
        CASE WHEN ${busySeconds}::float8 IS NULL THEN NULL ELSE now()-make_interval(secs => ${busySeconds}::float8) END)
      ON CONFLICT ("instanceId") DO UPDATE SET "beatAt"=now(),"lastPassOk"=EXCLUDED."lastPassOk","videoReady"=EXCLUDED."videoReady","busyJob"=EXCLUDED."busyJob","busySince"=EXCLUDED."busySince"`;
    // Replaced replicas (redeploys) leave rows behind; keep a week of them.
    await this.prisma.client.$executeRaw`
      DELETE FROM woori.worker_heartbeats WHERE "beatAt"<now()-interval '7 days'`;
  }
}
