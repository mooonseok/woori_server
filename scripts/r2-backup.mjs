// Daily copy of the private production R2 bucket into the separate backup
// bucket (W07-4). Dry-run by default; `--apply` copies new/changed objects
// server-side. Nothing is ever deleted from the backup unless
// `--apply --prune-older-than <days>` (>= 7) is given explicitly, and then only
// objects a backup run first found missing from the source <days>+ ago (kept
// in the backup bucket's _woori-backup/manifest.json). Safety stops: an empty
// source listing, the same bucket on both sides or a manifest written for a
// different source abort the run; a prune above 5% of the backup is skipped
// (copy still runs, exit 1) unless `--force-large-prune` is added after
// checking. Prints counts only: never keys, URLs or credentials. Run
// `pnpm build` first.
//   pnpm r2:backup                       # plan
//   pnpm r2:backup --apply               # copy (+ record orphans)
//   pnpm r2:backup --apply --prune-older-than 90 [--force-large-prune]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  planR2Backup,
  parseBackupManifest,
  BackupSafetyError,
  BACKUP_PREFIXES,
  BACKUP_MANIFEST_KEY,
  MAX_BACKUP_MANIFEST_BYTES,
} = require('../dist/src/common/media/r2-backup.js');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const pruneIndex = args.indexOf('--prune-older-than');
const pruneOlderThanDays =
  pruneIndex === -1 ? undefined : Number(args[pruneIndex + 1]);
const forceLargePrune = args.includes('--force-large-prune');
const known = new Set(['--apply', '--prune-older-than', '--force-large-prune']);
if (
  args.some(
    (arg, index) =>
      !known.has(arg) && !(pruneIndex !== -1 && index === pruneIndex + 1)
  )
) {
  console.error(
    'Usage: r2-backup [--apply] [--prune-older-than <days>=7+] [--force-large-prune]'
  );
  process.exit(2);
}
const env = process.env;
const accountId = env.R2_ACCOUNT_ID ?? '';
const source = env.R2_BUCKET ?? '';
const target = env.R2_BACKUP_BUCKET ?? '';
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
if (
  !/^[a-f0-9]{32}$/i.test(accountId) ||
  !bucketName.test(source) ||
  !bucketName.test(target) ||
  !env.R2_BACKUP_ACCESS_KEY_ID ||
  !env.R2_BACKUP_SECRET_ACCESS_KEY
) {
  console.error(
    'Set R2_ACCOUNT_ID, R2_BUCKET, R2_BACKUP_BUCKET, R2_BACKUP_ACCESS_KEY_ID and R2_BACKUP_SECRET_ACCESS_KEY (values are not printed).'
  );
  process.exit(2);
}
if (source === target) {
  console.error('The backup bucket must differ from the source bucket.');
  process.exit(2);
}
// One dedicated token (read on the source, read/write on the backup) so the
// copy stays server-side within the account and the app token never writes it.
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_BACKUP_ACCESS_KEY_ID,
    secretAccessKey: env.R2_BACKUP_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  maxAttempts: 3,
});
async function list(bucket) {
  const objects = [];
  for (const prefix of BACKUP_PREFIXES) {
    let token;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: token,
        }),
        { abortSignal: AbortSignal.timeout(30_000) }
      );
      for (const object of page.Contents ?? [])
        if (object.Key)
          objects.push({
            key: object.Key,
            size: Number(object.Size ?? 0),
            etag: object.ETag ?? '',
            lastModified: object.LastModified,
          });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  return objects;
}
async function readManifest() {
  try {
    const object = await client.send(
      new GetObjectCommand({ Bucket: target, Key: BACKUP_MANIFEST_KEY }),
      { abortSignal: AbortSignal.timeout(30_000) }
    );
    if (Number(object.ContentLength ?? 0) > MAX_BACKUP_MANIFEST_BYTES)
      throw new BackupSafetyError('MANIFEST_INVALID');
    return parseBackupManifest(await object.Body.transformToString());
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404)
      return null;
    throw error;
  }
}
async function inBatches(items, size, run) {
  let failed = 0;
  for (let offset = 0; offset < items.length; offset += size) {
    const results = await Promise.allSettled(
      items.slice(offset, offset + size).map(run)
    );
    failed += results.filter((result) => result.status === 'rejected').length;
  }
  return failed;
}
try {
  const manifest = await readManifest();
  const plan = planR2Backup(await list(source), await list(target), {
    sourceBucket: source,
    backupBucket: target,
    manifest,
    pruneOlderThanDays,
    forceLargePrune,
  });
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    toCopy: plan.copy.length,
    copyMegabytes: Math.round(plan.copyBytes / 1048576),
    unchanged: plan.unchanged,
    orphanedInBackup: plan.orphaned,
    pruneCandidates: plan.pruneCandidates,
    toPrune: plan.prune.length,
    pruneBlocked: plan.pruneBlocked,
    manifest: manifest ? 'existing' : 'new',
  };
  if (!apply) {
    console.log(JSON.stringify(summary));
    process.exit(plan.pruneBlocked ? 1 : 0);
  }
  const copyFailed = await inBatches(plan.copy, 4, (object) =>
    client.send(
      new CopyObjectCommand({
        Bucket: target,
        Key: object.key,
        CopySource: `${source}/${object.key
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`,
        MetadataDirective: 'COPY',
      }),
      { abortSignal: AbortSignal.timeout(120_000) }
    )
  );
  // A delete that failed keeps its first-seen time for the next run.
  const pruneFailed = await inBatches(plan.prune, 4, async (key) => {
    await client.send(new DeleteObjectCommand({ Bucket: target, Key: key }), {
      abortSignal: AbortSignal.timeout(30_000),
    });
    delete plan.manifest.orphans[key];
  });
  await client.send(
    new PutObjectCommand({
      Bucket: target,
      Key: BACKUP_MANIFEST_KEY,
      Body: JSON.stringify(plan.manifest),
      ContentType: 'application/json',
    }),
    { abortSignal: AbortSignal.timeout(30_000) }
  );
  console.log(
    JSON.stringify({
      ...summary,
      copied: plan.copy.length - copyFailed,
      copyFailed,
      pruned: plan.prune.length - pruneFailed,
      pruneFailed,
    })
  );
  if (copyFailed || pruneFailed || plan.pruneBlocked) process.exitCode = 1;
} catch (error) {
  if (error instanceof BackupSafetyError) {
    // Fixed codes only (SOURCE_EMPTY, SAME_BUCKET, MANIFEST_*): nothing changed.
    console.error(JSON.stringify({ status: 'aborted', reason: error.code }));
  } else
    // Provider errors can include request details; only a generic line is shown.
    console.error(
      'R2 backup failed (provider or network error; details withheld).'
    );
  process.exitCode = 1;
} finally {
  client.destroy();
}
