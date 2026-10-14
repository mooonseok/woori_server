import { defineConfig } from 'prisma/config';

// Migration scripts explicitly load .env via Node; build/typecheck never connect to the DB.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      'postgresql://not-configured@127.0.0.1:1/woori',
  },
});
