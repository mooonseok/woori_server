import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface VideoRange {
  start: number;
  end: number;
  length: number;
}
// One range only. Unsatisfiable/malformed/multipart ranges never reach R2.
export function videoRange(
  value: string | undefined,
  bytes: number
): VideoRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('INVALID_RANGE');
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    throw new Error('INVALID_RANGE');
  const start = first === null ? Math.max(0, bytes - last!) : first;
  const end =
    first === null || last === null ? bytes - 1 : Math.min(last, bytes - 1);
  if (start >= bytes || end < start || (first === null && last === 0))
    throw new Error('INVALID_RANGE');
  return { start, end, length: end - start + 1 };
}
export interface PrivateVideo {
  bytes: number;
  open: (range: VideoRange | null, signal: AbortSignal) => Promise<Readable>;
}
export async function streamPrivateVideo(
  request: Request,
  response: Response,
  video: PrivateVideo,
  download = false,
  filename = 'woori-video.mp4'
) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Vary', 'Cookie, Origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Type', 'video/mp4');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader(
    'Content-Disposition',
    download ? `attachment; filename="${filename}"` : 'inline'
  );
  let range: VideoRange | null;
  try {
    range = videoRange(
      request.method === 'HEAD' ? undefined : request.get('Range'),
      video.bytes
    );
  } catch {
    response.status(416).setHeader('Content-Range', `bytes */${video.bytes}`);
    response.end();
    return;
  }
  if (range)
    response
      .status(206)
      .setHeader(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${video.bytes}`
      );
  response.setHeader('Content-Length', range?.length ?? video.bytes);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  response.once('close', stop);
  if (request.aborted || response.destroyed) abort.abort();
  try {
    const body = await video.open(range, abort.signal);
    // pipeline applies backpressure; no full-file buffering, abort closes R2.
    await pipeline(body, response, { signal: abort.signal });
  } catch (error) {
    if (abort.signal.aborted || response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    for (const name of [
      'Content-Length',
      'Content-Range',
      'Content-Type',
      'Content-Disposition',
      'Accept-Ranges',
    ])
      response.removeHeader(name);
    throw error;
  } finally {
    response.off('close', stop);
  }
}
