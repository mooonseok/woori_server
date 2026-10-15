import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const {
  PrismaService,
} = require('../dist/src/common/modules/prisma/prisma.service.js');
const {
  MediaStorageService,
} = require('../dist/src/common/media/media-storage.service.js');
const {
  PhotoDateBackfillRepository,
} = require('../dist/src/domain/photos/photo-date-backfill.repository.js');
const {
  PhotoDateBackfillService,
} = require('../dist/src/domain/photos/photo-date-backfill.service.js');
const args = process.argv.slice(2);
const options = {};
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && options.apply === undefined)
      options.apply = true;
    else if (
      args[i] === '--limit' &&
      options.limit === undefined &&
      args[i + 1] !== undefined
    )
      options.limit = Number(args[++i]);
    else if (
      args[i] === '--after' &&
      options.after === undefined &&
      args[i + 1] !== undefined
    )
      options.after = args[++i];
    else throw new Error('Invalid arguments');
  }
  const prisma = new PrismaService();
  const storage = new MediaStorageService();
  try {
    const result = await new PhotoDateBackfillService(
      new PhotoDateBackfillRepository(prisma),
      storage
    ).run(options);
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
    storage.onModuleDestroy();
  }
} catch {
  // Driver/storage errors can contain connection strings or object identifiers.
  console.error(
    'Photo date backfill failed. Check local database, migration, storage settings and batch arguments.'
  );
  process.exitCode = 1;
}
