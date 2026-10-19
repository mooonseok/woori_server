import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';

test('isolated PostgreSQL: default API grants cannot expose the migration ledger', async () => {
  assert.equal(process.env.WOORI_INTEGRATION_TEST, '1');
  assert.notEqual(process.env.NODE_ENV, 'production');
  const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55439');
  assert.match(url.pathname, /^\/woori_test_[a-f0-9]{12}$/);
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    // Every role and grant change below rolls back, including when an assertion
    // fails. The disposable DB is also removed by the integration runner.
    await db.query('BEGIN');
    const roles = ['anon', 'authenticated', 'service_role', 'woori_api'];
    for (const role of roles) {
      const found = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [
        role,
      ]);
      if (!found.rowCount) await db.query(`CREATE ROLE "${role}" NOLOGIN`);
      await db.query(`GRANT ALL ON public._prisma_migrations TO "${role}"`);
    }
    await db.query('GRANT ALL ON public._prisma_migrations TO PUBLIC');
    const allowed = async (role: string) =>
      (
        await db.query(
          `SELECT has_table_privilege($1,'public._prisma_migrations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`,
          [role]
        )
      ).rows[0].allowed;
    for (const role of roles) assert.equal(await allowed(role), true);

    const grants = await readFile('prisma/runtime-grants.sql', 'utf8');
    await db.query(grants);
    await db.query(grants); // Repeat provisioning must remain safe.
    for (const role of roles) assert.equal(await allowed(role), false, role);
    assert.equal(
      await allowed(url.username),
      true,
      'migration owner retains access'
    );
    assert.equal(
      (
        await db.query(
          "SELECT has_table_privilege('woori_api','woori.users','SELECT') AS allowed"
        )
      ).rows[0].allowed,
      true,
      'application grants remain intact'
    );
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});
