import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  MAX_VIDEO_UPLOAD_BYTES,
  parseOutputProbe,
  parseVideoProbe,
  posterArgs,
  probeArgs,
  runTool,
  SAFE_INPUT,
  ToolError,
  transcodeArgs,
  uploadWindowMs,
  videoCapturedAt,
  videoPreset,
} from '../src/common/media/video-transcode';
import { startupFailure } from '../src/common/configurations/startup-diagnostics';
import { MediaStorageService } from '../src/common/media/media-storage.service';
import {
  mediaCountText,
  pushBody,
  withObjectParticle,
} from '../src/domain/notifications/notification-bundles';

const now = new Date('2026-10-16T03:00:00Z');
// Shape of real `ffprobe -print_format json -show_format -show_streams` output.
const source = (
  video: Record<string, unknown> = {},
  format: Record<string, unknown> = {},
  extra: Record<string, unknown>[] = []
) => ({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
      duration: '12.012000',
      disposition: { attached_pic: 0 },
      ...video,
    },
    { codec_type: 'audio', codec_name: 'aac' },
    ...extra,
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.034000',
    tags: { creation_time: '2026-10-15T01:02:03.000000Z' },
    ...format,
  },
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpException);
    return (error.getResponse() as { code: string }).code;
  }
  assert.fail('expected a rejection');
};

test('ffprobe parsing accepts camera H.264/HEVC within 60.5 s and applies rotation', () => {
  assert.deepEqual(parseVideoProbe(source(), now), {
    durationMs: 12034,
    width: 1920,
    height: 1080,
    codec: 'h264',
    hasAudio: true,
    audioStream: 0,
    capturedAt: new Date('2026-10-15T01:02:03Z'),
  });
  for (const rotation of [90, -90, 270]) {
    const rotated = parseVideoProbe(
      source({
        codec_name: 'hevc',
        side_data_list: [{ side_data_type: 'Display Matrix', rotation }],
      }),
      now
    );
    assert.deepEqual([rotated.width, rotated.height], [1080, 1920]);
  }
  // Legacy rotate tag (older ffprobe) and 180 degrees (no swap).
  assert.equal(
    parseVideoProbe(source({ tags: { rotate: '90' } }), now).width,
    1080
  );
  assert.equal(
    parseVideoProbe(source({ side_data_list: [{ rotation: 180 }] }), now).width,
    1920
  );
  // Embedded cover art is not a second video track.
  assert.equal(
    parseVideoProbe(
      source({}, {}, [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 300,
          height: 300,
          disposition: { attached_pic: 1 },
        },
      ]),
      now
    ).codec,
    'h264'
  );
  assert.equal(
    parseVideoProbe(source({}, { duration: '60.500000' }), now).durationMs,
    60500
  );
  assert.equal(
    parseVideoProbe(source({}, { duration: undefined }), now).durationMs,
    12012
  );
  assert.equal(
    parseVideoProbe(source({ codec_type: 'video' }), now).hasAudio,
    true
  );
});

test('ffprobe parsing rejects long, non-video, multi-track and absurd inputs', () => {
  assert.equal(
    code(() => parseVideoProbe(source({}, { duration: '60.501' }), now)),
    'VIDEO_TOO_LONG'
  );
  for (const bad of [
    source({ codec_name: 'vp9' }),
    source({ codec_name: 'prores' }),
    source({ codec_type: 'audio' }),
    source({}, { format_name: 'matroska,webm' }),
    source({}, { format_name: 'png_pipe' }),
    source({ width: 5000, height: 2000 }),
    source({ width: 4096, height: 4096 }),
    source({ width: 8, height: 1080 }),
    source({ width: 1920.5 }),
    source({ avg_frame_rate: '480/1' }),
    source({ duration: 'N/A' }, { duration: 'N/A' }),
    source({}, {}, [
      { codec_type: 'video', codec_name: 'h264', width: 64, height: 64 },
    ]),
    {},
    null,
    { streams: 'x', format: 5 },
  ])
    assert.equal(
      code(() => parseVideoProbe(bad, now)),
      'VIDEO_UNSUPPORTED'
    );
});

test('capture time comes from QuickTime/MP4 metadata; junk epochs and future fall back', () => {
  assert.deepEqual(
    videoCapturedAt(
      {
        'com.apple.quicktime.creationdate': '2026-10-16T00:30:00+0900',
        creation_time: '2026-10-15T15:29:59.000000Z',
      },
      now
    ),
    new Date('2026-10-15T15:30:00Z')
  );
  assert.deepEqual(
    videoCapturedAt({ creation_time: '2021-05-05T03:00:00.000000Z' }, now),
    new Date('2021-05-05T03:00:00Z')
  );
  for (const value of [
    '1970-01-01T00:00:00.000000Z',
    '1904-01-01T00:00:00Z',
    '2026-10-18T00:00:00Z',
    'yesterday',
    '2026-13-01T00:00:00Z',
  ])
    assert.equal(videoCapturedAt({ creation_time: value }, now), null, value);
  assert.equal(videoCapturedAt(undefined, now), null);
});

test('transcode command: H.264/yuv420p <=1080p, CRF 23, AAC, faststart, metadata stripped', () => {
  const args = transcodeArgs('/tmp/in', '/tmp/out.mp4');
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/in');
  assert.equal(args.at(-1), '/tmp/out.mp4');
  assert.equal(at('-c:v'), 'libx264');
  assert.equal(at('-crf'), '23');
  assert.equal(at('-preset'), 'veryfast');
  assert.equal(at('-profile:v'), 'high');
  assert.equal(at('-c:a'), 'aac');
  assert.equal(at('-movflags'), '+faststart');
  assert.equal(at('-fpsmax'), '60');
  assert.equal(at('-maxrate'), '8M');
  assert.equal(at('-t'), '61');
  assert.equal(at('-threads'), '2');
  assert.match(at('-vf'), /format=yuv420p$/);
  assert.match(at('-vf'), /min\(1920,iw\)/);
  assert.match(at('-vf'), /min\(1080,ih\)/);
  assert.match(at('-vf'), /force_original_aspect_ratio=decrease/);
  for (const flag of [
    '-map_metadata',
    '-map_metadata:s:v',
    '-map_metadata:s:a',
    '-map_chapters',
  ])
    assert.equal(at(flag), '-1', flag);
  for (const flag of ['-dn', '-sn', '-nostdin'])
    assert.ok(args.includes(flag), flag);
  assert.deepEqual(
    args.filter((_, index) => args[index - 1] === '-map'),
    ['0:v:0', '0:a:0']
  );
  // Input hardening before -i: local files only, the MOV/MP4 demuxer only,
  // bounded decoder threads.
  const input = args.slice(0, args.indexOf('-i')).join(' ');
  assert.match(input, /-threads 2 -protocol_whitelist file -f mov$/);
  // Audio: the probed allowed track; none allowed -> silent video.
  const second = transcodeArgs('a', 'b', 'veryfast', 1);
  assert.deepEqual(
    second.filter((_, index) => second[index - 1] === '-map'),
    ['0:v:0', '0:a:1']
  );
  const silent = transcodeArgs('a', 'b', 'veryfast', null);
  assert.deepEqual(
    silent.filter((_, index) => silent[index - 1] === '-map'),
    ['0:v:0']
  );
  assert.ok(silent.includes('-an') && !silent.includes('-c:a'));
  for (const bad of [-1, 0.5])
    assert.throws(() => transcodeArgs('a', 'b', 'veryfast', bad));
  assert.equal(
    transcodeArgs('a', 'b', 'medium')[args.indexOf('-preset') + 1],
    'medium'
  );
  assert.throws(() => transcodeArgs('a', 'b', 'placebo; rm -rf'));
  assert.deepEqual(posterArgs('in.mp4', 'p.png', 400).slice(5, 7), [
    '-ss',
    '0',
  ]);
  assert.deepEqual(posterArgs('in.mp4', 'p.png', 4000).slice(5, 7), [
    '-ss',
    '0.5',
  ]);
  const poster = posterArgs('in.mp4', 'p.png', 4000);
  assert.deepEqual(
    poster.slice(
      poster.indexOf('-i') - SAFE_INPUT.length,
      poster.indexOf('-i')
    ),
    SAFE_INPUT
  );
  const probe = probeArgs('/tmp/in');
  assert.equal(probe.at(-1), '/tmp/in');
  assert.ok(probe.join(' ').includes('-protocol_whitelist file -f mov'));
});

test('audio: the first allowed camera codec is kept; other tracks are dropped', () => {
  const withAudio = (...codecs: string[]) => ({
    ...source(),
    streams: [
      source().streams[0],
      ...codecs.map((codec_name) => ({ codec_type: 'audio', codec_name })),
    ],
  });
  // Spatial/unknown audio is never decoded; the AAC track after it is used.
  assert.equal(parseVideoProbe(withAudio('apac', 'aac'), now).audioStream, 1);
  for (const codecs of [['apac'], ['eac3'], ['truehd', 'dts']]) {
    const parsed = parseVideoProbe(withAudio(...codecs), now);
    assert.equal(parsed.audioStream, null, codecs.join());
    assert.equal(parsed.hasAudio, true);
  }
  for (const codec of ['aac', 'alac', 'mp3', 'opus', 'pcm_s16le'])
    assert.equal(parseVideoProbe(withAudio(codec), now).audioStream, 0);
  assert.equal(parseVideoProbe(withAudio(), now).audioStream, null);
});

test('x264 preset is an allowlisted deploy setting', () => {
  assert.equal(videoPreset({}), 'veryfast');
  assert.equal(videoPreset({ VIDEO_X264_PRESET: ' medium ' }), 'medium');
  for (const bad of ['placebo', 'veryslow', 'fast; rm -rf /', 'VERYFAST']) {
    let failure = '';
    try {
      videoPreset({ VIDEO_X264_PRESET: bad });
    } catch (error) {
      failure = startupFailure(error);
    }
    assert.match(failure, /^\[CONFIG\] VIDEO_X264_PRESET/, bad);
    assert.ok(!failure.includes(bad), 'value never echoed');
  }
});

test('upload window: photos 10 minutes, videos sized for a 1 Mbit/s uplink up to 60', () => {
  const minute = 60_000;
  assert.equal(uploadWindowMs('image/jpeg', 30 * 1024 * 1024), 10 * minute);
  assert.equal(uploadWindowMs('video/mp4', 1), 10 * minute + 1000);
  // 200 MB: ~1678 s of transfer + 10 minutes margin (~38 minutes).
  const largest = uploadWindowMs('video/quicktime', MAX_VIDEO_UPLOAD_BYTES);
  assert.equal(largest, (1678 + 600) * 1000);
  assert.equal(uploadWindowMs('video/mp4', 10 * 1024 ** 3), 60 * minute);
});

test('output probe must be browser-safe H.264 within the size box', () => {
  const output = (video: Record<string, unknown>) => ({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        width: 1080,
        height: 1920,
        ...video,
      },
    ],
    format: { duration: '59.98' },
  });
  assert.deepEqual(parseOutputProbe(output({})), {
    width: 1080,
    height: 1920,
    durationMs: 59980,
  });
  for (const bad of [
    output({ codec_name: 'hevc' }),
    output({ pix_fmt: 'yuv420p10le' }),
    output({ width: 2160, height: 3840 }),
    output({ width: 1200, height: 1200 }),
  ])
    assert.equal(
      code(() => parseOutputProbe(bad)),
      'TRANSCODE_FAILED'
    );
});

test('media tools run without a shell and fail closed', async () => {
  await assert.rejects(
    runTool('/nonexistent/woori-ffmpeg', ['-version'], 2000),
    (error) => error instanceof ToolError && error.failure === 'spawn'
  );
  await assert.rejects(
    runTool(process.execPath, ['-e', 'process.exit(3)'], 5000),
    (error) => error instanceof ToolError && error.failure === 'exit'
  );
  await assert.rejects(
    runTool(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 200),
    (error) => error instanceof ToolError && error.failure === 'timeout'
  );
  // Killed from outside (OOM killer, container stop): an environment failure.
  await assert.rejects(
    runTool(
      process.execPath,
      ['-e', 'process.kill(process.pid, "SIGKILL")'],
      5000
    ),
    (error) => error instanceof ToolError && error.failure === 'signal'
  );
  // Worker shutdown aborts a running tool, and a pre-aborted signal never spawns.
  const controller = new AbortController();
  const running = runTool(
    process.execPath,
    ['-e', 'setTimeout(()=>{},10000)'],
    5000,
    1024,
    controller.signal
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    running,
    (error) => error instanceof ToolError && error.failure === 'aborted'
  );
  await assert.rejects(
    runTool('/nonexistent/woori-ffmpeg', [], 5000, 1024, controller.signal),
    (error) => error instanceof ToolError && error.failure === 'aborted'
  );
  await assert.rejects(
    runTool(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(5000))'],
      5000,
      100
    ),
    (error) => error instanceof ToolError && error.failure === 'output'
  );
  assert.equal(
    await runTool(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', '$(touch /tmp/x);'],
      5000
    ),
    '$(touch /tmp/x);'
  );
});

test('upload signing accepts videos up to 200 MB without public read URLs', async () => {
  const storage = new MediaStorageService({
    accountId: 'a'.repeat(32),
    accessKeyId: 'unit-test-access-key',
    secretAccessKey: 'unit-test-secret-key',
    bucket: 'woori-unit-test',
  });
  try {
    const staging = 'staging/11111111-1111-4111-8111-111111111111';
    await storage.presign(staging, 'video/quicktime', MAX_VIDEO_UPLOAD_BYTES);
    // The signed PUT lives exactly as long as the reservation window.
    const ticket = await storage.presign(
      staging,
      'video/mp4',
      MAX_VIDEO_UPLOAD_BYTES,
      2278
    );
    assert.equal(
      new URL(ticket.uploadUrl).searchParams.get('X-Amz-Expires'),
      '2278'
    );
    for (const seconds of [59, 3601, 90.5])
      await assert.rejects(
        storage.presign(staging, 'video/mp4', 1000, seconds)
      );
    await assert.rejects(
      storage.presign(staging, 'video/mp4', MAX_VIDEO_UPLOAD_BYTES + 1)
    );
    await assert.rejects(
      storage.presign(staging, 'image/jpeg', 30 * 1024 * 1024 + 1)
    );
    await assert.rejects(storage.presign(staging, 'video/webm', 1000));
  } finally {
    storage.onModuleDestroy();
  }
});

test('notification text counts photos and videos of a bundle', () => {
  assert.equal(mediaCountText(5, 0), '사진 5장');
  assert.equal(mediaCountText(3, 3), '동영상 3개');
  assert.equal(mediaCountText(4, 1), '사진·동영상 4개');
  assert.equal(withObjectParticle('사진 5장'), '사진 5장을');
  assert.equal(withObjectParticle('동영상 3개'), '동영상 3개를');
  const row = {
    kind: 'PHOTOS',
    actorName: '엄마',
    albumTitle: '여름',
    count: 2,
    videoCount: 2,
  };
  assert.equal(pushBody(row, true), "엄마님이 '여름'에 동영상 2개를 올렸어요.");
  assert.equal(
    pushBody({ ...row, videoCount: 1 }, true),
    "엄마님이 '여름'에 사진·동영상 2개를 올렸어요."
  );
  assert.equal(
    pushBody({ ...row, kind: 'REACTION', count: 3, mediaKind: 'VIDEO' }, true),
    '엄마님 외 2명이 내 동영상에 반응했어요.'
  );
  assert.equal(
    pushBody({ ...row, kind: 'COMMENT', count: 1, mediaKind: 'VIDEO' }, true),
    '엄마님이 내 동영상에 댓글을 남겼어요.'
  );
  assert.equal(pushBody(row, false), '새로운 소식이 있어요.');
});
