import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';

// W07-3 video policy (user-confirmed 2026-10-16): up to 1 minute and 200 MB per
// video, transcoded by the worker to H.264/AAC MP4. Only the transcoded MP4 and
// its poster images are stored; the uploaded original is discarded.
export const VIDEO_MIMES = ['video/mp4', 'video/quicktime'] as const;
export const MAX_VIDEO_UPLOAD_BYTES = 200 * 1024 * 1024;
export const PHOTO_UPLOAD_WINDOW_MS = 10 * 60_000;
export const MAX_UPLOAD_WINDOW_MS = 60 * 60_000;
/**
 * How long the signed PUT and the reservation stay valid. Photos: 10 minutes
 * (unchanged). Videos: the time at a slow 1 Mbit/s uplink plus 10 minutes,
 * between 10 and 60 minutes (200 MB: about 38 minutes).
 */
export function uploadWindowMs(contentType: string, bytes: number) {
  if (!(VIDEO_MIMES as readonly string[]).includes(contentType))
    return PHOTO_UPLOAD_WINDOW_MS;
  const transferMs = Math.ceil((bytes * 8) / 1_000_000) * 1000;
  return Math.min(
    MAX_UPLOAD_WINDOW_MS,
    Math.max(PHOTO_UPLOAD_WINDOW_MS, transferMs + 10 * 60_000)
  );
}
// 60 s plus container/encoder rounding (phones report 60.02 s for "1:00").
export const MAX_VIDEO_DURATION_MS = 60_500;
// Output bound: 8 Mbit/s video cap + 128 kbit/s audio for 60.5 s is ~62 MB.
export const MAX_VIDEO_OUTPUT_BYTES = 150 * 1024 * 1024;
export const VIDEO_LONG_EDGE = 1920;
export const VIDEO_SHORT_EDGE = 1080;
const MIN_SOURCE_EDGE = 16;
const MAX_SOURCE_EDGE = 4096;
const MAX_SOURCE_PIXELS = 4096 * 2304;
const MAX_SOURCE_FPS = 240;
// iPhone/Android camera codecs only: every extra decoder is attack surface.
const ACCEPTED_CODECS = new Set(['h264', 'hevc']);
// Camera/phone audio. Another codec (e.g. a spatial-audio track) is never
// decoded: the first allowed audio track is used, and with none the video is
// kept without sound (the picture is what members share).
const ACCEPTED_AUDIO_CODECS = new Set([
  'aac',
  'alac',
  'mp3',
  'opus',
  'pcm_s16le',
  'pcm_s16be',
  'pcm_s24le',
]);
export const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
] as const;
export const VIDEO_PRESET_ERROR =
  'VIDEO_X264_PRESET must be one of ultrafast, superfast, veryfast, faster, fast, medium';
/** Validated at worker start and --check; default veryfast (measured cost). */
export function videoPreset(env: NodeJS.ProcessEnv = process.env) {
  const value = env.VIDEO_X264_PRESET?.trim() || 'veryfast';
  if (!(X264_PRESETS as readonly string[]).includes(value))
    throw new Error(VIDEO_PRESET_ERROR);
  return value;
}
export const PROBE_TIMEOUT_MS = 20_000;
export const TRANSCODE_TIMEOUT_MS = 240_000;
export const POSTER_TIMEOUT_MS = 30_000;

export type VideoFailureCode =
  'VIDEO_TOO_LONG' | 'VIDEO_UNSUPPORTED' | 'TRANSCODE_FAILED';
// Terminal (not retried) rejections carry the stored processingErrorCode.
export function videoRejected(code: VideoFailureCode) {
  return code === 'TRANSCODE_FAILED'
    ? new UnprocessableEntityException({ code })
    : new BadRequestException({ code });
}
export function videoToolsUnavailable() {
  return new ServiceUnavailableException({ code: 'VIDEO_TOOLS_UNAVAILABLE' });
}
// Environment/load, not the file: a timeout or a tool killed by a signal (e.g.
// out of memory). Retried; the worker gives up as TRANSCODE_FAILED after 3 attempts.
export function videoInterrupted() {
  return new ServiceUnavailableException({ code: 'TRANSCODE_INTERRUPTED' });
}
export function videoAborted() {
  return new ServiceUnavailableException({ code: 'MEDIA_PROCESSING_ABORTED' });
}

export interface VideoProbe {
  durationMs: number;
  // Displayed (rotation-applied) size of the source.
  width: number;
  height: number;
  codec: string;
  hasAudio: boolean;
  // Position among the audio streams (ffmpeg a:N) of the first allowed audio
  // codec; null keeps the video silent.
  audioStream: number | null;
  capturedAt: Date | null;
}
type ProbeStream = {
  codec_type?: unknown;
  codec_name?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  avg_frame_rate?: unknown;
  disposition?: { attached_pic?: unknown };
  side_data_list?: { rotation?: unknown }[];
  tags?: Record<string, unknown>;
};
type ProbeJson = {
  streams?: ProbeStream[];
  format?: {
    format_name?: unknown;
    duration?: unknown;
    tags?: Record<string, unknown>;
  };
};

function seconds(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function rate(value: unknown) {
  if (typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  return Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0
    ? num / den
    : null;
}
function rotation(stream: ProbeStream) {
  const side = stream.side_data_list?.find(
    (entry) => typeof entry.rotation === 'number'
  )?.rotation;
  const tag = stream.tags?.rotate;
  const value =
    typeof side === 'number' ? side : typeof tag === 'string' ? Number(tag) : 0;
  return Number.isFinite(value) ? Math.abs(Math.round(value)) % 180 : 0;
}

// QuickTime keeps the local capture time with its offset; MP4 keeps UTC in
// creation_time. Encoders write 1904/1970 epochs when unset, so anything before
// 1971 (or in the future) falls back to the upload date like a bad EXIF date.
export function videoCapturedAt(
  tags: Record<string, unknown> | undefined,
  now = new Date()
): Date | null {
  for (const key of ['com.apple.quicktime.creationdate', 'creation_time']) {
    const raw = tags?.[key];
    if (typeof raw !== 'string' || raw.length > 40) continue;
    const normalized = raw.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(
        normalized
      )
    )
      continue;
    const value = new Date(normalized);
    if (
      Number.isFinite(value.getTime()) &&
      value.getTime() >= Date.UTC(1971, 0, 1) &&
      value.getTime() <= now.getTime() + 24 * 60 * 60_000
    )
      return value;
  }
  return null;
}

/** Authoritative validation of the uploaded file (never the client's claims). */
export function parseVideoProbe(raw: unknown, now = new Date()): VideoProbe {
  const probe = (raw ?? {}) as ProbeJson;
  const formatName =
    typeof probe.format?.format_name === 'string'
      ? probe.format.format_name.split(',')
      : [];
  if (!formatName.includes('mov') && !formatName.includes('mp4'))
    throw videoRejected('VIDEO_UNSUPPORTED');
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  // Cover art (attached pictures) is not a second video track.
  const videos = streams.filter(
    (stream) =>
      stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
  );
  if (videos.length !== 1) throw videoRejected('VIDEO_UNSUPPORTED');
  const video = videos[0];
  if (
    typeof video.codec_name !== 'string' ||
    !ACCEPTED_CODECS.has(video.codec_name)
  )
    throw videoRejected('VIDEO_UNSUPPORTED');
  const width = video.width,
    height = video.height;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    Math.min(width, height) < MIN_SOURCE_EDGE ||
    Math.max(width, height) > MAX_SOURCE_EDGE ||
    width * height > MAX_SOURCE_PIXELS
  )
    throw videoRejected('VIDEO_UNSUPPORTED');
  const fps = rate(video.avg_frame_rate);
  if (fps !== null && fps > MAX_SOURCE_FPS)
    throw videoRejected('VIDEO_UNSUPPORTED');
  const duration = seconds(probe.format?.duration) ?? seconds(video.duration);
  if (duration === null) throw videoRejected('VIDEO_UNSUPPORTED');
  const durationMs = Math.round(duration * 1000);
  if (durationMs > MAX_VIDEO_DURATION_MS) throw videoRejected('VIDEO_TOO_LONG');
  const swapped = rotation(video) === 90;
  const audio = streams.filter((stream) => stream.codec_type === 'audio');
  const allowed = audio.findIndex(
    (stream) =>
      typeof stream.codec_name === 'string' &&
      ACCEPTED_AUDIO_CODECS.has(stream.codec_name)
  );
  return {
    durationMs,
    width: swapped ? height : width,
    height: swapped ? width : height,
    codec: video.codec_name,
    hasAudio: audio.length > 0,
    audioStream: allowed === -1 ? null : allowed,
    capturedAt: videoCapturedAt(probe.format?.tags, now),
  };
}

/** The transcoded file must be exactly what browsers play everywhere. */
export function parseOutputProbe(raw: unknown) {
  const probe = (raw ?? {}) as ProbeJson & {
    streams?: (ProbeStream & { pix_fmt?: unknown })[];
  };
  const videos = (probe.streams ?? []).filter(
    (stream) => stream.codec_type === 'video'
  );
  const video = videos[0] as (ProbeStream & { pix_fmt?: unknown }) | undefined;
  const duration =
    seconds(probe.format?.duration) ?? seconds(video?.duration ?? undefined);
  if (
    videos.length !== 1 ||
    video?.codec_name !== 'h264' ||
    video.pix_fmt !== 'yuv420p' ||
    typeof video.width !== 'number' ||
    typeof video.height !== 'number' ||
    Math.max(video.width, video.height) > VIDEO_LONG_EDGE ||
    Math.min(video.width, video.height) > VIDEO_SHORT_EDGE ||
    duration === null ||
    Math.round(duration * 1000) > MAX_VIDEO_DURATION_MS + 500
  )
    throw videoRejected('TRANSCODE_FAILED');
  return {
    width: video.width,
    height: video.height,
    durationMs: Math.max(1, Math.round(duration * 1000)),
  };
}

// Input hardening for every ffmpeg/ffprobe call: only the QuickTime/MP4
// demuxer (no format probing into playlists/concat/images), only local files
// (no network or other protocols; external data references stay off by
// default), and bounded decoder threads. Supported by FFmpeg 5.1 and later.
export const SAFE_INPUT = ['-protocol_whitelist', 'file', '-f', 'mov'];
export function probeArgs(input: string) {
  return [
    '-v',
    'error',
    ...SAFE_INPUT,
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    input,
  ];
}

// H.264 High/yuv420p (plays on every browser), long edge <= 1920 and short edge
// <= 1080 without upscaling, at most 60 fps, CRF 23 with an 8 Mbit/s ceiling,
// AAC stereo, moov atom first for progressive playback. Global, stream and
// chapter metadata (capture location, device, creation time) and data/subtitle
// tracks are dropped; rotation is applied to the pixels.
export function transcodeArgs(
  input: string,
  output: string,
  preset = 'veryfast',
  audioStream: number | null = 0
) {
  if (!(X264_PRESETS as readonly string[]).includes(preset))
    throw new Error('Unsupported x264 preset');
  if (
    audioStream !== null &&
    (!Number.isInteger(audioStream) || audioStream < 0)
  )
    throw new Error('Invalid audio stream');
  const long = VIDEO_LONG_EDGE,
    short = VIDEO_SHORT_EDGE;
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '2',
    ...SAFE_INPUT,
    '-i',
    input,
    '-map',
    '0:v:0',
    ...(audioStream === null ? [] : ['-map', `0:a:${audioStream}`]),
    '-map_metadata',
    '-1',
    '-map_metadata:s:v',
    '-1',
    '-map_metadata:s:a',
    '-1',
    '-map_chapters',
    '-1',
    '-dn',
    '-sn',
    '-t',
    String(Math.ceil(MAX_VIDEO_DURATION_MS / 1000)),
    '-vf',
    `scale=w='if(gte(iw,ih),min(${long},iw),min(${short},iw))':h='if(gte(iw,ih),min(${short},ih),min(${long},ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    '-fpsmax',
    '60',
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    '23',
    '-profile:v',
    'high',
    '-maxrate',
    '8M',
    '-bufsize',
    '16M',
    ...(audioStream === null
      ? ['-an']
      : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
    // Two encoder threads: measured ~30% less total CPU and ~40% less memory
    // than automatic threading for a 60 s 1080p clip (cost cap: worker CPU).
    '-threads',
    '2',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

// One PNG frame from the transcoded file (already rotated and scaled), half a
// second in (or the first frame of a shorter clip).
export function posterArgs(input: string, output: string, durationMs: number) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    durationMs > 1000 ? '0.5' : '0',
    '-threads',
    '2',
    ...SAFE_INPUT,
    '-i',
    input,
    '-frames:v',
    '1',
    '-an',
    '-f',
    'image2',
    '-c:v',
    'png',
    output,
  ];
}

export function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}
export function ffprobePath() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}
// exit: the tool rejected the input (a file problem). timeout/signal: the
// environment (load, memory). aborted: worker shutdown.
export type ToolFailure =
  'spawn' | 'timeout' | 'exit' | 'output' | 'signal' | 'aborted';
export class ToolError extends Error {
  constructor(readonly failure: ToolFailure) {
    super(`media tool ${failure}`);
  }
}
/**
 * Runs ffmpeg/ffprobe without a shell, with a hard timeout (SIGKILL) and a
 * bounded stdout. stderr is drained but never logged (it can contain paths).
 */
export function runTool(
  bin: string,
  args: string[],
  timeoutMs: number,
  maxStdoutBytes = 1024 * 1024,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError('aborted'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: ToolFailure | null = null;
    let settled = false;
    const settle = (error: ToolError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => {
      failure = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    const abort = () => {
      failure ??= 'aborted';
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxStdoutBytes) {
        failure ??= 'output';
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    // A missing binary emits 'error' and may never emit 'close'.
    child.once('error', () => {
      child.kill('SIGKILL');
      settle(new ToolError(failure ?? 'spawn'));
    });
    child.once('close', (code, killedBy) => {
      if (failure) settle(new ToolError(failure));
      else if (killedBy) settle(new ToolError('signal'));
      else if (code !== 0) settle(new ToolError('exit'));
      else settle(null);
    });
  });
}

/** Worker --check: ffmpeg/ffprobe present with the libx264 and AAC encoders. */
export async function checkVideoTools() {
  let preset = true;
  try {
    videoPreset();
  } catch {
    preset = false;
  }
  try {
    const version = await runTool(
      ffmpegPath(),
      ['-hide_banner', '-version'],
      10_000
    );
    const encoders = await runTool(
      ffmpegPath(),
      ['-hide_banner', '-encoders'],
      10_000
    );
    await runTool(ffprobePath(), ['-hide_banner', '-version'], 10_000);
    const ffmpeg = /ffmpeg version (\S+)/.exec(version)?.[1] ?? 'unknown';
    const libx264 = /^\s*V\S*\s+libx264\s/m.test(encoders);
    const aac = /^\s*A\S*\s+aac\s/m.test(encoders);
    return { ready: libx264 && aac && preset, ffmpeg, libx264, aac, preset };
  } catch {
    return { ready: false, ffmpeg: null, libx264: false, aac: false, preset };
  }
}
