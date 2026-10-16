import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ReconciliationPhoto {
  id: string;
  status: string;
  deletedAt: Date | null;
  stagingKey: string | null;
  uploadExpiresAt: Date | null;
  processingUntil: Date | null;
  variants: { objectKey: string; bytes: bigint }[];
}
export interface ReconciliationReader {
  page(limit: number, after?: string): Promise<ReconciliationPhoto[]>;
  current(id: string): Promise<ReconciliationPhoto | null>;
}
export interface ReconciliationObjects {
  list(prefix: string): Promise<{
    objects: { key: string; modified: Date | null }[];
    truncated: boolean;
  }>;
  head(key: string): Promise<{ bytes: number; modified: Date | null } | null>;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fingerprint = (p: ReconciliationPhoto | null) =>
  JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Metadata-only, photo-row-scoped audit. Never changes the DB or deletes objects. */
export async function reconcileMedia(
  reader: ReconciliationReader,
  objects: ReconciliationObjects,
  options: { limit?: number; after?: string; now?: Date } = {}
) {
  const limit = options.limit ?? 20,
    now = options.now ?? new Date();
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (options.after && !uuid.test(options.after))
  )
    throw new Error('Invalid reconciliation options');
  const rows = await reader.page(limit, options.after);
  const reports: {
    photoId: string;
    missingReferences: number;
    sizeMismatches: number;
    unreferencedObjects: number;
    expiredStaging: number;
    truncated: boolean;
  }[] = [];
  let skippedActive = 0,
    skippedChanged = 0,
    failed = 0;
  const cutoff = now.getTime() - 60 * 60_000;
  for (const row of rows) {
    try {
      if (!uuid.test(row.id)) throw new Error('Invalid photo identifier');
      // PROCESSING includes queued/retry work even when the current lease has expired.
      if (
        row.status === 'PROCESSING' ||
        (row.processingUntil && row.processingUntil.getTime() > cutoff) ||
        (row.uploadExpiresAt && row.uploadExpiresAt.getTime() > cutoff)
      ) {
        skippedActive++;
        continue;
      }
      const prefix = `photos/${row.id}/`;
      const referenceKeys = new Set(row.variants.map((v) => v.objectKey));
      if (row.variants.some((v) => !v.objectKey.startsWith(prefix)))
        throw new Error('Reference outside photo prefix');
      const listed = await objects.list(prefix);
      let missingReferences = 0,
        sizeMismatches = 0;
      if (row.status === 'READY' && !row.deletedAt) {
        for (const variant of row.variants) {
          const head = await objects.head(variant.objectKey);
          if (!head) missingReferences++;
          else if (BigInt(head.bytes) !== variant.bytes) sizeMismatches++;
        }
      }
      const unreferencedObjects = listed.objects.filter(
        (o) =>
          o.key.startsWith(prefix) &&
          !referenceKeys.has(o.key) &&
          o.modified &&
          o.modified.getTime() <= cutoff
      ).length;
      let expiredStaging = 0;
      if (
        row.stagingKey &&
        row.uploadExpiresAt &&
        row.uploadExpiresAt.getTime() <= cutoff
      ) {
        if (!/^staging\/[a-f0-9-]{36}$/i.test(row.stagingKey))
          throw new Error('Unexpected staging prefix');
        const head = await objects.head(row.stagingKey);
        if (head?.modified && head.modified.getTime() <= cutoff)
          expiredStaging = 1;
      }
      if (fingerprint(row) !== fingerprint(await reader.current(row.id))) {
        skippedChanged++;
        continue;
      }
      reports.push({
        photoId: row.id,
        missingReferences,
        sizeMismatches,
        unreferencedObjects,
        expiredStaging,
        truncated: listed.truncated,
      });
    } catch {
      failed++;
    }
  }
  return {
    mode: 'report-only',
    scope: 'photo-row-prefixes-only',
    minimumObjectAgeMinutes: 60,
    scanned: rows.length,
    skippedActive,
    skippedChanged,
    failed,
    reports,
    nextCursor: rows.length === limit ? rows.at(-1)!.id : null,
  };
}

/** Only List and Head commands are exposed, never a signed URL or object content. */
export class ReconciliationStorage implements ReconciliationObjects {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string
  ) {}
  async list(prefix: string) {
    if (!/^photos\/[a-f0-9-]{36}\/$/i.test(prefix))
      throw new Error('Invalid prefix');
    const page = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1000,
      }),
      { abortSignal: AbortSignal.timeout(10_000) }
    );
    return {
      objects: (page.Contents ?? []).map((o) => ({
        key: o.Key ?? '',
        modified: o.LastModified ?? null,
      })),
      truncated: page.IsTruncated === true,
    };
  }
  async head(key: string) {
    if (
      !/^(photos|staging)\/[a-zA-Z0-9/_-]+(?:\.(jpg|png|webp|mp4))?$/.test(
        key
      ) ||
      key.includes('//') ||
      key.length > 240
    )
      throw new Error('Invalid key');
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(10_000) }
      );
      if (
        !Number.isSafeInteger(result.ContentLength) ||
        result.ContentLength! < 0
      )
        throw new Error('Invalid size');
      return {
        bytes: result.ContentLength!,
        modified: result.LastModified ?? null,
      };
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
}
