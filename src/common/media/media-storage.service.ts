import {
  BadRequestException,
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
import { Readable } from 'node:stream';
import sharp, { OutputInfo } from 'sharp';
import { exifCapturedAt } from './photo-capture-date';

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
  kind: 'ORIGINAL' | 'DISPLAY' | 'THUMBNAIL';
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
      !/^(staging|photos)\/[a-zA-Z0-9/_-]+(?:\.(?:jpg|png|webp))?$/.test(key) ||
      key.includes('//') ||
      key.length > 240 ||
      (prefix && !key.startsWith(prefix))
    )
      throw uploadInvalid();
  }
  async presign(stagingKey: string, contentType: string, byteSize: number) {
    this.validKey(stagingKey, 'staging/');
    if (
      !Object.values(mimeByFormat).includes(contentType) ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 1 ||
      byteSize > MAX_UPLOAD_BYTES
    )
      throw uploadInvalid();
    const expiresIn = 600;
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
      `^(?:staging/${uuid}|photos/${photoId}/${uuid}/(?:original\\.(?:jpg|png|webp)|display\\.webp|thumbnail\\.webp))$`
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
