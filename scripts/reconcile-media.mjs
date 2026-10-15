import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const {
  PrismaService,
} = require('../dist/src/common/modules/prisma/prisma.service.js');
const {
  assertLocalBackfillDatabase,
} = require('../dist/src/domain/photos/photo-date-backfill.service.js');
const {
  PhotoReconciliationRepository,
} = require('../dist/src/domain/photos/photo-reconciliation.repository.js');
const {
  ReconciliationStorage,
  reconcileMedia,
} = require('../dist/src/common/media/media-reconciliation.js');
const { S3Client } = require('@aws-sdk/client-s3');
try {
  assertLocalBackfillDatabase(process.env.DATABASE_URL);
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && options.limit === undefined && args[i + 1])
      options.limit = Number(args[++i]);
    else if (
      args[i] === '--after' &&
      options.after === undefined &&
      args[i + 1]
    )
      options.after = args[++i];
    else throw new Error('Invalid argument');
  }
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } =
    process.env;
  if (
    !/^[a-f0-9]{32}$/i.test(R2_ACCOUNT_ID ?? '') ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(R2_BUCKET ?? '')
  )
    throw new Error('Storage settings missing');
  const prisma = new PrismaService(),
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      maxAttempts: 2,
    });
  try {
    const result = await reconcileMedia(
      new PhotoReconciliationRepository(prisma),
      new ReconciliationStorage(client, R2_BUCKET),
      options
    );
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
    client.destroy();
  }
} catch {
  console.error(
    'Media report failed. Check local DB, storage settings and --limit/--after. This command never deletes data.'
  );
  process.exitCode = 1;
}
