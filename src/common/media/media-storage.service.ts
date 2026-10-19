import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  OnModuleDestroy,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { VideoRange } from './video-response';
import sharp, { OutputInfo } from 'sharp';
import { exifCapturedAt } from './photo-capture-date';
import {
  ffmpegPath,
  ffprobePath,
  MAX_VIDEO_OUTPUT_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  parseOutputProbe,
  parseVideoProbe,
  posterArgs,
  POSTER_TIMEOUT_MS,
  probeArgs,
  PROBE_TIMEOUT_MS,
  runTool,
  ToolError,
  TRANSCODE_TIMEOUT_MS,
  transcodeArgs,
  VIDEO_MIMES,
  videoAborted,
  videoInterrupted,
  videoPreset,
  videoRejected,
  videoToolsUnavailable,
} from './video-transcode';

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_VARIANT_BYTES = 90 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 60_000_000;
// Bound retained native cache and per-image threads; this is not an RSS limit.
// Each process has its own cache and processing slots. Deployment memory
// budgets must account for both API and worker processes.
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(1);
export const MEDIA_STORAGE_OPTIONS = Symbol('MEDIA_STORAGE_OPTIONS');
export interface MediaStorageOptions {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
}
export interface MediaVariant {
  capturedAt?: Date | null;
  // VIDEO: the transcoded H.264 MP4 (videos keep no ORIGINAL variant).
  kind: 'ORIGINAL' | 'DISPLAY' | 'THUMBNAIL' | 'VIDEO';
  durationMs?: number;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}
const mimeByFormat: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const uploadInvalid = () =>
  new BadRequestException({ code: 'INVALID_PHOTO_FILE' });
const VIDEO_TEMP_PREFIX = 'woori-video-';
const isVideoMime = (mime: string) =>
  (VIDEO_MIMES as readonly string[]).includes(mime);
const unavailable = () =>
  new ServiceUnavailableException({ code: 'MEDIA_STORAGE_UNAVAILABLE' });

/** Count bytes even when an object server omits or lies about Content-Length. */
export async function collectBounded(
  body: Readable,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw uploadInvalid();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    body.destroy();
  }
}

@Injectable()
export class MediaStorageService implements OnModuleDestroy {
  private client?: S3Client;
  private readonly options: MediaStorageOptions;
  private processing = 0;
  // Transcoding is CPU-bound: one video at a time per process.
  private videoProcessing = 0;
  constructor(
    @Optional() @Inject(MEDIA_STORAGE_OPTIONS) options?: MediaStorageOptions
  ) {
    this.options = options ?? {
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      bucket: process.env.R2_BUCKET,
    };
  }
  enabled(): boolean {
    const o = this.options;
    return !!(
      o.accountId &&
      /^[a-f0-9]{32}$/i.test(o.accountId) &&
      o.accessKeyId &&
      o.secretAccessKey &&
      o.bucket &&
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)
    );
  }
  private sdk(): S3Client {
    if (!this.enabled())
      throw new ServiceUnavailableException({
        code: 'MEDIA_STORAGE_NOT_CONFIGURED',
      });
    return (this.client ??= new S3Client({
      region: 'auto',
      endpoint: `https://${this.options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this.options.accessKeyId!,
        secretAccessKey: this.options.secretAccessKey!,
      },
      forcePathStyle: true,
      maxAttempts: 2,
      // An automatic checksum for an empty signing body would reject a real browser PUT.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }));
  }
  private validKey(key: string, prefix?: string): void {
    if (
      !/^(staging|photos)\/[a-zA-Z0-9/_-]+(?:\.(?:jpg|png|webp|mp4))?$/.test(
        key
      ) ||
      key.includes('//') ||
      key.length > 240 ||
      (prefix && !key.startsWith(prefix))
    )
      throw uploadInvalid();
  }
  async presign(
    stagingKey: string,
    contentType: string,
    byteSize: number,
    expiresInSeconds = 600
  ) {
    this.validKey(stagingKey, 'staging/');
    const video = isVideoMime(contentType);
    if (
      (!video && !Object.values(mimeByFormat).includes(contentType)) ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 1 ||
      byteSize > (video ? MAX_VIDEO_UPLOAD_BYTES : MAX_UPLOAD_BYTES)
    )
      throw uploadInvalid();
    // The reservation's window (uploadWindowMs): 10 min for photos, up to 60
    // for large videos.
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > 3600
    )
      throw uploadInvalid();
    const expiresIn = expiresInSeconds;
    const uploadUrl = await getSignedUrl(
      this.sdk(),
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: stagingKey,
        ContentType: contentType,
        ContentLength: byteSize,
      }),
      {
        expiresIn,
        signableHeaders: new Set(['content-type', 'content-length']),
      }
    );
    // Browsers set Content-Length from the File/Blob body; JS must not set that forbidden header.
    return {
      uploadUrl,
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }
  protected async download(
    key: string,
    maxBytes: number
  ): Promise<{ data: Buffer; contentType: string }> {
    this.validKey(key);
    const client = this.sdk();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30_000);
    let body: Readable | undefined;
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { abortSignal: abort.signal }
      );
      if (!(response.Body instanceof Readable)) throw unavailable();
      body = response.Body;
      const abortBody = () =>
        body?.destroy(new Error('Storage read timed out'));
      abort.signal.addEventListener('abort', abortBody, { once: true });
      body.once('close', () =>
        abort.signal.removeEventListener('abort', abortBody)
      );
      if (abort.signal.aborted) throw unavailable();
      if (
        response.ContentLength !== undefined &&
        response.ContentLength > maxBytes
      )
        throw uploadInvalid();
      const data = await collectBounded(body, maxBytes);
      if (
        response.ContentLength !== undefined &&
        response.ContentLength !== data.length
      )
        throw uploadInvalid();
      return {
        data,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      body?.destroy();
    }
  }
  protected async put(key: string, data: Buffer, mime: string): Promise<void> {
    this.validKey(key, 'photos/');
    try {
      await this.sdk().send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: data,
          ContentType: mime,
          ContentLength: data.length,
          CacheControl: 'private, no-store',
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(30_000) }
      );
    } catch {
      throw unavailable();
    }
  }
  async captureDate(objectKey: string, bytes: number): Promise<Date | null> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES)
      throw uploadInvalid();
    this.validKey(objectKey, 'photos/');
    const { data } = await this.download(objectKey, bytes);
    if (data.length !== bytes) throw uploadInvalid();
    const metadata = await sharp(data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    return exifCapturedAt(metadata.exif);
  }
  async process(
    stagingKey: string,
    expectedMime: string,
    expectedBytes: number,
    uniqueFinalPrefix: string
  ): Promise<MediaVariant[]> {
    this.validKey(stagingKey, 'staging/');
    this.validKey(uniqueFinalPrefix, 'photos/');
    if (
      !Object.values(mimeByFormat).includes(expectedMime) ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > MAX_UPLOAD_BYTES
    )
      throw uploadInvalid();
    if (this.processing >= 2)
      throw new ServiceUnavailableException({ code: 'MEDIA_PROCESSING_BUSY' });
    this.processing++;
    const attempted: string[] = [];
    try {
      const { data, contentType } = await this.download(
        stagingKey,
        expectedBytes
      );
      if (
        data.length !== expectedBytes ||
        contentType.split(';')[0].trim() !== expectedMime
      )
        throw uploadInvalid();
      let display: { data: Buffer; info: OutputInfo };
      let thumbnail: { data: Buffer; info: OutputInfo };
      let width: number, height: number, format: string;
      let capturedAt: Date | null = null;
      try {
        const image = sharp(data, {
          limitInputPixels: MAX_IMAGE_PIXELS,
          failOn: 'warning',
        });
        const meta = await image.metadata();
        capturedAt = exifCapturedAt(meta.exif);
        if (
          !meta.format ||
          mimeByFormat[meta.format] !== expectedMime ||
          !meta.width ||
          !meta.height ||
          (meta.pages ?? 1) !== 1 ||
          meta.width * meta.height > MAX_IMAGE_PIXELS
        )
          throw uploadInvalid();
        format = meta.format;
        const swapped = meta.orientation !== undefined && meta.orientation >= 5;
        width = swapped ? meta.height : meta.width;
        height = swapped ? meta.width : meta.height;
        // A successful decode is required before retaining original bytes. Derivatives omit EXIF/GPS.
        display = await image
          .clone()
          .autoOrient()
          .resize({
            width: 2560,
            height: 2560,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 85 })
          .timeout({ seconds: 15 })
          .toBuffer({ resolveWithObject: true });
        thumbnail = await image
          .clone()
          .autoOrient()
          .resize({
            width: 480,
            height: 480,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .timeout({ seconds: 15 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw uploadInvalid();
      }
      if (
        data.length + display.data.length + thumbnail.data.length >
          MAX_TOTAL_VARIANT_BYTES ||
        display.data.length > MAX_UPLOAD_BYTES ||
        thumbnail.data.length > MAX_UPLOAD_BYTES
      )
        throw uploadInvalid();
      const objects = [
        {
          kind: 'ORIGINAL' as const,
          suffix: `original.${format === 'jpeg' ? 'jpg' : format}`,
          mime: expectedMime,
          data,
          width,
          height,
        },
        {
          kind: 'DISPLAY' as const,
          suffix: 'display.webp',
          mime: 'image/webp',
          data: display.data,
          width: display.info.width,
          height: display.info.height,
        },
        {
          kind: 'THUMBNAIL' as const,
          suffix: 'thumbnail.webp',
          mime: 'image/webp',
          data: thumbnail.data,
          width: thumbnail.info.width,
          height: thumbnail.info.height,
        },
      ];
      const result: MediaVariant[] = [];
      for (const object of objects) {
        const objectKey = `${uniqueFinalPrefix}/${object.suffix}`;
        attempted.push(objectKey);
        await this.put(objectKey, object.data, object.mime);
        result.push({
          kind: object.kind,
          ...(object.kind === 'ORIGINAL' ? { capturedAt } : {}),
          objectKey,
          mime: object.mime,
          width: object.width,
          height: object.height,
          bytes: object.data.length,
        });
      }
      return result;
    } catch (error) {
      await this.cleanup(attempted);
      throw error;
    } finally {
      this.processing--;
    }
  }
  /** Streams a private object to a local file, bounded by the declared size. */
  protected async downloadToFile(
    key: string,
    path: string,
    maxBytes: number
  ): Promise<{ bytes: number; contentType: string }> {
    this.validKey(key);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
      const response = await this.sdk().send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { abortSignal: abort.signal }
      );
      if (!(response.Body instanceof Readable)) throw unavailable();
      if (
        response.ContentLength !== undefined &&
        response.ContentLength > maxBytes
      )
        throw uploadInvalid();
      let size = 0;
      await pipeline(
        response.Body,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            done(size > maxBytes ? uploadInvalid() : null, chunk);
          },
        }),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: abort.signal }
      );
      return {
        bytes: size,
        contentType: response.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  protected async putFile(key: string, path: string, mime: string) {
    this.validKey(key, 'photos/');
    const { size } = await stat(path);
    try {
      await this.sdk().send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentType: mime,
          ContentLength: size,
          CacheControl: 'private, no-store',
          IfNoneMatch: '*',
        }),
        { abortSignal: AbortSignal.timeout(120_000) }
      );
    } catch {
      throw unavailable();
    }
  }
  // Best effort: temp dirs of a crashed transcode older than an hour.
  private async sweepVideoTemp() {
    try {
      const root = tmpdir();
      for (const name of await readdir(root)) {
        if (!name.startsWith(VIDEO_TEMP_PREFIX)) continue;
        const path = join(root, name);
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 60 * 60_000)
          await rm(path, { recursive: true, force: true });
      }
    } catch {
      /* A later pass retries; never fail a job for the sweep. */
    }
  }
  /**
   * Worker-only video pipeline: ffprobe validation -> H.264/AAC MP4 transcode
   * (metadata stripped, rotation applied) -> poster frame -> display/thumbnail
   * WebP posters at the photo variant sizes. The original is not retained.
   * Invalid input: 400 VIDEO_TOO_LONG / VIDEO_UNSUPPORTED, 422 TRANSCODE_FAILED
   * (terminal); missing tools or storage errors: 503 (retried by the queue).
   */
  async processVideo(
    stagingKey: string,
    expectedMime: string,
    expectedBytes: number,
    uniqueFinalPrefix: string,
    signal?: AbortSignal
  ): Promise<MediaVariant[]> {
    this.validKey(stagingKey, 'staging/');
    this.validKey(uniqueFinalPrefix, 'photos/');
    if (
      !isVideoMime(expectedMime) ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > MAX_VIDEO_UPLOAD_BYTES
    )
      throw videoRejected('VIDEO_UNSUPPORTED');
    let preset: string;
    try {
      preset = videoPreset();
    } catch {
      // A deployment setting, never the member's file (also checked at start).
      throw videoToolsUnavailable();
    }
    if (this.videoProcessing >= 1)
      throw new ServiceUnavailableException({ code: 'MEDIA_PROCESSING_BUSY' });
    this.videoProcessing++;
    const attempted: string[] = [];
    let dir: string | undefined;
    // Missing tools, shutdown, timeouts and kills (load/memory) are the
    // environment's problem and retried; a tool rejecting the input is the
    // file's problem (fileProblem).
    const tool = async (
      bin: string,
      args: string[],
      timeoutMs: number,
      fileProblem: () => HttpException
    ) => {
      try {
        return await runTool(bin, args, timeoutMs, 1024 * 1024, signal);
      } catch (error) {
        if (error instanceof ToolError) {
          if (error.failure === 'spawn') throw videoToolsUnavailable();
          if (error.failure === 'aborted') throw videoAborted();
          if (error.failure === 'timeout' || error.failure === 'signal')
            throw videoInterrupted();
        }
        throw fileProblem();
      }
    };
    const unsupported = () => videoRejected('VIDEO_UNSUPPORTED');
    const transcodeFailed = () => videoRejected('TRANSCODE_FAILED');
    try {
      await this.sweepVideoTemp();
      dir = await mkdtemp(join(tmpdir(), VIDEO_TEMP_PREFIX));
      const source = join(dir, 'source');
      const output = join(dir, 'video.mp4');
      const poster = join(dir, 'poster.png');
      const downloaded = await this.downloadToFile(
        stagingKey,
        source,
        expectedBytes
      ).catch((error: unknown) => {
        throw error instanceof BadRequestException
          ? videoRejected('VIDEO_UNSUPPORTED')
          : error;
      });
      if (
        downloaded.bytes !== expectedBytes ||
        downloaded.contentType.split(';')[0].trim() !== expectedMime
      )
        throw videoRejected('VIDEO_UNSUPPORTED');
      let probe;
      try {
        probe = parseVideoProbe(
          JSON.parse(
            await tool(
              ffprobePath(),
              probeArgs(source),
              PROBE_TIMEOUT_MS,
              unsupported
            )
          )
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw unsupported();
      }
      let result;
      try {
        await tool(
          ffmpegPath(),
          transcodeArgs(source, output, preset, probe.audioStream),
          TRANSCODE_TIMEOUT_MS,
          transcodeFailed
        );
        result = parseOutputProbe(
          JSON.parse(
            await tool(
              ffprobePath(),
              probeArgs(output),
              PROBE_TIMEOUT_MS,
              transcodeFailed
            )
          )
        );
        await tool(
          ffmpegPath(),
          posterArgs(output, poster, result.durationMs),
          POSTER_TIMEOUT_MS,
          transcodeFailed
        );
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw videoRejected('TRANSCODE_FAILED');
      }
      const { size: videoBytes } = await stat(output);
      if (videoBytes < 1 || videoBytes > MAX_VIDEO_OUTPUT_BYTES)
        throw videoRejected('TRANSCODE_FAILED');
      let display: { data: Buffer; info: OutputInfo };
      let thumbnail: { data: Buffer; info: OutputInfo };
      try {
        const frame = sharp(poster, { limitInputPixels: MAX_IMAGE_PIXELS });
        display = await frame
          .clone()
          .resize({
            width: 2560,
            height: 2560,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 85 })
          .timeout({ seconds: 15 })
          .toBuffer({ resolveWithObject: true });
        thumbnail = await frame
          .clone()
          .resize({
            width: 480,
            height: 480,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 78 })
          .timeout({ seconds: 15 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw videoRejected('TRANSCODE_FAILED');
      }
      const videoKey = `${uniqueFinalPrefix}/video.mp4`;
      attempted.push(videoKey);
      await this.putFile(videoKey, output, 'video/mp4');
      const variants: MediaVariant[] = [
        {
          kind: 'VIDEO',
          capturedAt: probe.capturedAt,
          durationMs: result.durationMs,
          objectKey: videoKey,
          mime: 'video/mp4',
          width: result.width,
          height: result.height,
          bytes: videoBytes,
        },
      ];
      for (const [kind, suffix, image] of [
        ['DISPLAY', 'display.webp', display],
        ['THUMBNAIL', 'thumbnail.webp', thumbnail],
      ] as const) {
        const objectKey = `${uniqueFinalPrefix}/${suffix}`;
        attempted.push(objectKey);
        await this.put(objectKey, image.data, 'image/webp');
        variants.push({
          kind,
          objectKey,
          mime: 'image/webp',
          width: image.info.width,
          height: image.info.height,
          bytes: image.data.length,
        });
      }
      return variants;
    } catch (error) {
      await this.cleanup(attempted);
      throw error;
    } finally {
      this.videoProcessing--;
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  /** Private R2 stream. The caller authorizes before and after opening it. */
  async openVideo(
    objectKey: string,
    bytes: number,
    range: VideoRange | null,
    signal: AbortSignal
  ): Promise<Readable> {
    this.validKey(objectKey, 'photos/');
    if (
      !objectKey.endsWith('/video.mp4') ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_VIDEO_OUTPUT_BYTES
    )
      throw uploadInvalid();
    let body: Readable | undefined;
    try {
      const object = await this.sdk().send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectKey,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
        { abortSignal: signal }
      );
      body = object.Body as Readable;
      if (
        !(body instanceof Readable) ||
        object.ContentLength !== (range?.length ?? bytes) ||
        (range &&
          object.ContentRange !== `bytes ${range.start}-${range.end}/${bytes}`)
      )
        throw unavailable();
      const stream = body;
      // The caller rechecks DB permissions before attaching pipeline. Keep
      // socket errors handled during that await; Readable.errored retains it.
      stream.on('error', () => undefined);
      const abort = () => stream.destroy();
      signal.addEventListener('abort', abort, { once: true });
      stream.once('close', () => signal.removeEventListener('abort', abort));
      if (signal.aborted) stream.destroy();
      return stream;
    } catch {
      body?.destroy();
      throw unavailable();
    }
  }
  async read(objectKey: string, maxBytes: number) {
    this.validKey(objectKey, 'photos/');
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_UPLOAD_BYTES
    )
      throw uploadInvalid();
    const { data, contentType } = await this.download(objectKey, maxBytes);
    return { body: Readable.from([data]), contentType, byteSize: data.length };
  }
  /** Durable deletion never swallows provider errors or accepts a bucket-wide prefix. */
  async removePhotoObjects(
    photoId: string,
    objectKeys: string[]
  ): Promise<void> {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    if (!new RegExp(`^${uuid}$`).test(photoId)) throw uploadInvalid();
    const prefix = `photos/${photoId}/`;
    const allowed = new RegExp(
      `^(?:staging/${uuid}|photos/${photoId}/${uuid}/(?:original\\.(?:jpg|png|webp)|video\\.mp4|display\\.webp|thumbnail\\.webp))$`
    );
    if (!objectKeys.every((key) => allowed.test(key))) throw uploadInvalid();
    const listed = await this.listPhotoKeys(prefix);
    if (!listed.every((key) => allowed.test(key))) throw uploadInvalid();
    const keys = [...new Set([...objectKeys, ...listed])];
    // A bounded batch avoids overwhelming R2 while keeping work inside the job lease.
    for (let offset = 0; offset < keys.length; offset += 10) {
      await Promise.all(
        keys.slice(offset, offset + 10).map((key) => this.removeAndConfirm(key))
      );
    }
    // More than one page (or a concurrent late attempt) stays pending for another pass.
    if ((await this.listPhotoKeys(prefix)).length) throw unavailable();
  }
  protected async listPhotoKeys(prefix: string): Promise<string[]> {
    try {
      const response = await this.sdk().send(
        new ListObjectsV2Command({
          Bucket: this.options.bucket,
          Prefix: prefix,
          MaxKeys: 200,
        }),
        { abortSignal: AbortSignal.timeout(5000) }
      );
      return (response.Contents ?? [])
        .map((object) => object.Key!)
        .filter(Boolean);
    } catch {
      throw unavailable();
    }
  }
  protected async removeAndConfirm(key: string): Promise<void> {
    try {
      await this.sdk().send(
        new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(5000) }
      );
      try {
        await this.sdk().send(
          new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(5000) }
        );
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404
        )
          return;
        throw unavailable();
      }
      throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  async cleanup(keys: string[]): Promise<void> {
    if (!keys.length || !this.enabled()) return;
    for (const key of keys) {
      try {
        this.validKey(key);
        await this.sdk().send(
          new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(5000) }
        );
      } catch {
        /* Private staging lifecycle is a fallback; never expose provider error secrets. */
      }
    }
  }
  onModuleDestroy() {
    this.client?.destroy();
  }
}
