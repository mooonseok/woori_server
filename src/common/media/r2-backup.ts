// W07-4 daily R2 backup (production bucket -> separate backup bucket).
// Pure planning: incremental by key + size + ETag. The backup never loses an
// object unless pruning is explicitly requested, and then only objects that
// the backup run itself first saw missing from the source N+ days ago. That
// first-seen time lives in a manifest object in the backup bucket (a copy's
// own lastModified only says when it was copied, not when it left the source).
export interface BackupObject {
  key: string;
  size: number;
  etag: string;
  lastModified?: Date;
}
export interface BackupManifest {
  version: 1;
  sourceBucket: string;
  // Backup key -> ISO time a run first found it missing from the source.
  orphans: Record<string, string>;
}
// Photos and profile photos (avatars/). Removed avatars leave the source and
// are pruned from the backup like deleted photos.
export const BACKUP_PREFIXES = ['photos/', 'avatars/'] as const;
// Outside BACKUP_PREFIXES, so never listed, copied or pruned as a photo.
export const BACKUP_MANIFEST_KEY = '_woori-backup/manifest.json';
export const MAX_BACKUP_MANIFEST_BYTES = 32 * 1024 * 1024;
// A run that would prune more than this share of the backup stops pruning
// (copying continues) unless --force-large-prune is given after checking.
export const MAX_PRUNE_RATIO = 0.05;
export type BackupSafetyCode =
  | 'SOURCE_EMPTY'
  | 'SAME_BUCKET'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_SOURCE_MISMATCH';
export class BackupSafetyError extends Error {
  constructor(readonly code: BackupSafetyCode) {
    super(`R2 backup aborted: ${code}`);
  }
}
const normalizeEtag = (etag: string) =>
  etag.replace(/^W\//, '').replace(/"/g, '');

/** null when the manifest object does not exist yet (first run). */
export function parseBackupManifest(
  text: string | null
): BackupManifest | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupSafetyError('MANIFEST_INVALID');
  }
  const manifest = value as Partial<BackupManifest> | null;
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.version !== 1 ||
    typeof manifest.sourceBucket !== 'string' ||
    !manifest.orphans ||
    typeof manifest.orphans !== 'object' ||
    Array.isArray(manifest.orphans) ||
    Object.values(manifest.orphans).some(
      (seen) => typeof seen !== 'string' || Number.isNaN(Date.parse(seen))
    )
  )
    throw new BackupSafetyError('MANIFEST_INVALID');
  return manifest as BackupManifest;
}

export function planR2Backup(
  source: BackupObject[],
  backup: BackupObject[],
  options: {
    sourceBucket: string;
    backupBucket: string;
    manifest: BackupManifest | null;
    pruneOlderThanDays?: number;
    forceLargePrune?: boolean;
    now?: Date;
  }
) {
  const now = options.now ?? new Date();
  if (
    options.pruneOlderThanDays !== undefined &&
    (!Number.isInteger(options.pruneOlderThanDays) ||
      options.pruneOlderThanDays < 7)
  )
    throw new Error('Prune requires at least 7 whole days');
  // Suspicious configuration stops the whole run before anything changes:
  // an empty listing usually means a wrong bucket, prefix or token, and every
  // backup object would otherwise start ageing toward a prune.
  if (options.sourceBucket === options.backupBucket)
    throw new BackupSafetyError('SAME_BUCKET');
  if (!source.length) throw new BackupSafetyError('SOURCE_EMPTY');
  if (
    options.manifest &&
    options.manifest.sourceBucket !== options.sourceBucket
  )
    throw new BackupSafetyError('MANIFEST_SOURCE_MISMATCH');
  const existing = new Map(backup.map((object) => [object.key, object]));
  const copy: BackupObject[] = [];
  let unchanged = 0;
  for (const object of source) {
    const current = existing.get(object.key);
    if (
      current &&
      current.size === object.size &&
      normalizeEtag(current.etag) === normalizeEtag(object.etag)
    )
      unchanged++;
    else copy.push(object);
  }
  const live = new Set(source.map((object) => object.key));
  // First-seen times carry over; keys back in the source (or gone from the
  // backup) leave the manifest; newly missing keys start ageing now.
  const previous = options.manifest?.orphans ?? {};
  const orphans: Record<string, string> = {};
  for (const object of backup)
    if (!live.has(object.key))
      orphans[object.key] = Object.hasOwn(previous, object.key)
        ? previous[object.key]
        : now.toISOString();
  const cutoff =
    options.pruneOlderThanDays === undefined
      ? null
      : now.getTime() - options.pruneOlderThanDays * 86_400_000;
  const due =
    cutoff === null
      ? []
      : Object.entries(orphans)
          .filter(([, seen]) => Date.parse(seen) < cutoff)
          .map(([key]) => key);
  const pruneBlocked =
    due.length > backup.length * MAX_PRUNE_RATIO && !options.forceLargePrune
      ? ('PRUNE_RATIO_EXCEEDED' as const)
      : null;
  const prune = pruneBlocked ? [] : due;
  // The caller removes each key from manifest.orphans once its delete
  // succeeded; a failed delete keeps its first-seen time for the next run.
  return {
    copy,
    unchanged,
    prune,
    pruneBlocked,
    pruneCandidates: due.length,
    orphaned: Object.keys(orphans).length,
    copyBytes: copy.reduce((sum, object) => sum + object.size, 0),
    manifest: {
      version: 1,
      sourceBucket: options.sourceBucket,
      orphans,
    } satisfies BackupManifest,
  };
}

// Written only after a run with no copy/prune failure, outside BACKUP_PREFIXES
// like the manifest. A read-only check of the backup bucket (or the restore
// drill) can tell when the last complete backup finished.
export const BACKUP_LAST_SUCCESS_KEY = '_woori-backup/last-success.json';

export function lastSuccessRecord(input: {
  sourceBucket: string;
  startedAt: Date;
  finishedAt: Date;
  sourceObjects: number;
  copied: number;
  unchanged: number;
  sourceGone: number;
}) {
  return {
    version: 1 as const,
    sourceBucket: input.sourceBucket,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    sourceObjects: input.sourceObjects,
    copied: input.copied,
    unchanged: input.unchanged,
    sourceGone: input.sourceGone,
  };
}

// Orphans only grow while pruning stays manual; a manifest over the read limit
// would stop every later run, so it is never written past the limit and the
// summary warns well before that.
export function manifestSizeStatus(
  bytes: number
): 'ok' | 'near-limit' | 'too-large' {
  if (bytes > MAX_BACKUP_MANIFEST_BYTES) return 'too-large';
  return bytes > MAX_BACKUP_MANIFEST_BYTES * 0.8 ? 'near-limit' : 'ok';
}

// A source object deleted between listing and copy (photo deletion, media
// cleanup) is normal, not a failed backup. Only the object-level NoSuchKey
// counts; a missing bucket (NoSuchBucket, also 404) stays a failure.
export const sourceGone = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === 'NoSuchKey';

// Provider errors may carry request details, so only the SDK error name and
// HTTP status are reported (e.g. AccessDenied 403, NoSuchBucket 404).
export function backupFailureSummary(error: unknown) {
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  } | null;
  const name =
    typeof value?.name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.name)
      ? value.name
      : 'Error';
  const status = value?.$metadata?.httpStatusCode;
  return {
    status: 'failed' as const,
    error: name,
    httpStatus: Number.isInteger(status) ? (status as number) : null,
  };
}
