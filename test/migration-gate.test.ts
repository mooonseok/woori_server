import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DB_LEDGER_PROBLEM,
  DB_MANUAL,
  DB_OK,
  checksumMatches,
  classifyMigrations,
  isMigrationName,
  ledgerDecision,
  ledgerPlan,
  migrationChecksum,
  normalizeStatements,
  planHash,
  releaseDbChanges,
} from '../src/common/release/migration-gate';

const one = (sql: string, name = '20261201000000_t') =>
  classifyMigrations([{ name, sql }])[0];
const kinds = (sql: string) =>
  one(sql)
    .statements.filter((s) => !s.allowed)
    .map((s) => s.kind);

test('allowlisted statements: additive forms, and only on tables the batch creates when they lock or scan', () => {
  const created = 'CREATE TABLE woori.t (id UUID NOT NULL, "a" INT);\n';
  for (const sql of [
    'CREATE SCHEMA IF NOT EXISTS "woori";',
    `CREATE TYPE "woori"."Kind" AS ENUM ('A', 'B');`,
    `ALTER TYPE woori."Kind" ADD VALUE IF NOT EXISTS 'C' AFTER 'B';`,
    `${created}CREATE UNIQUE INDEX t_a ON woori.t("a") WHERE "a" > 0;`,
    `${created}ALTER TABLE "woori"."t" ADD CONSTRAINT c CHECK ("a" >= 0), ENABLE ROW LEVEL SECURITY;`,
    `${created}ALTER TABLE woori.t ADD CONSTRAINT f FOREIGN KEY ("a") REFERENCES woori.users(id) ON DELETE CASCADE;`,
    `${created}CREATE TRIGGER tr BEFORE UPDATE ON woori.t FOR EACH ROW EXECUTE FUNCTION woori.touch();`,
    `${created}INSERT INTO woori.t (id) VALUES ('x');`,
    'ALTER TABLE woori.users ADD COLUMN "avatarKey" VARCHAR(160);',
    'ALTER TABLE woori.users ADD COLUMN "v" INTEGER NOT NULL DEFAULT 0, ADD COLUMN w BOOLEAN NOT NULL DEFAULT true;',
    `ALTER TABLE woori.photos ADD COLUMN "mediaKind" "woori"."MediaKind" NOT NULL DEFAULT 'IMAGE'::"woori"."MediaKind";`,
    `ALTER TABLE woori.users ALTER COLUMN nickname SET DEFAULT ('m_' || substr(gen_random_uuid()::text, 1, 8));`,
    'ALTER TABLE woori.users ALTER COLUMN a DROP DEFAULT, ALTER COLUMN b DROP NOT NULL;',
    'ALTER TABLE woori.users ADD CONSTRAINT c CHECK (a > 0) NOT VALID;',
    'ALTER TABLE woori.users VALIDATE CONSTRAINT c;',
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS u_a ON woori.users(a);',
    `COMMENT ON COLUMN woori.users.a IS 'drop table x; delete from y';`,
    'REVOKE ALL ON ALL TABLES IN SCHEMA "woori" FROM PUBLIC;',
    'GRANT SELECT, UPDATE ("avatarKey") ON woori.users TO woori_api;',
    'GRANT EXECUTE ON FUNCTION woori.touch() TO woori_api;',
    '-- DROP TABLE x;\n/* TRUNCATE /* nested */ y */ ALTER TABLE woori.users ADD COLUMN z TEXT;',
  ])
    assert.deepEqual(kinds(sql), [], sql);

  for (const [sql, expected] of [
    ['DROP TABLE woori.photos;', ['drop table']],
    ['DROP INDEX woori."i";', ['drop index']],
    ['ALTER TABLE woori.users DROP COLUMN a;', ['alter table: drop column']],
    [
      'ALTER TABLE woori.users RENAME COLUMN a TO b;',
      ['alter table: rename column'],
    ],
    ['ALTER TABLE woori.users RENAME TO people;', ['alter table: rename to']],
    [
      'ALTER TABLE woori.users ALTER COLUMN a TYPE BIGINT;',
      ['alter table: alter column type'],
    ],
    [
      'ALTER TABLE woori.users ALTER COLUMN a SET NOT NULL;',
      ['alter table: set not null'],
    ],
    ['ALTER TABLE woori.users SET SCHEMA other;', ['alter table: set schema']],
    ['ALTER TABLE woori.users SET UNLOGGED;', ['alter table: set unlogged']],
    [
      'ALTER TABLE woori.users DISABLE ROW LEVEL SECURITY;',
      ['alter table: disable row'],
    ],
    [
      'ALTER TABLE woori.p DETACH PARTITION woori.p1;',
      ['alter table: detach partition'],
    ],
    [
      'ALTER TABLE woori.users ENABLE ROW LEVEL SECURITY;',
      ['alter table: enable row level security'],
    ],
    [
      'ALTER TABLE woori.users ADD COLUMN a INT NOT NULL;',
      ['alter table: add column not null without default'],
    ],
    [
      'ALTER TABLE woori.users ADD COLUMN a UUID DEFAULT gen_random_uuid();',
      ['alter table: add column with a computed default'],
    ],
    [
      'ALTER TABLE woori.users ADD COLUMN a UUID REFERENCES woori.groups(id);',
      ['alter table: add column with constraint'],
    ],
    [
      'ALTER TABLE woori.users ADD CONSTRAINT c CHECK (a > 0);',
      ['alter table: add constraint check'],
    ],
    [
      'ALTER TABLE woori.users ADD CONSTRAINT u UNIQUE (a) NOT VALID;',
      ['alter table: add constraint unique'],
    ],
    ['CREATE INDEX u_a ON woori.users(a);', ['create index on existing table']],
    [
      'CREATE UNIQUE INDEX u_a ON "woori"."users"("a");',
      ['create index on existing table'],
    ],
    [
      'CREATE INDEX CONCURRENTLY u_a ON woori.users(a); SELECT 1;',
      ['create index concurrently (not alone)', 'select 1'],
    ],
    ['TRUNCATE woori.sessions;', ['truncate woori.sessions']],
    ['DELETE FROM woori.sessions;', ['delete from']],
    [`UPDATE woori.users SET a = 'x';`, ['update woori.users']],
    ['ALTER SEQUENCE woori.s RESTART WITH 1;', ['alter sequence']],
    [`SELECT setval('woori.s', 1);`, ["select setval('s',"]],
    ['CALL woori.cleanup();', ['call woori.cleanup()']],
    ['DO $$ BEGIN PERFORM woori.cleanup(); END $$;', ['do $body$']],
    [
      'CREATE RULE r AS ON INSERT TO woori.users DO INSTEAD NOTHING;',
      ['create rule'],
    ],
    ['LOCK TABLE woori.users;', ['lock table']],
    ['GRANT SELECT ON woori.users TO anon;', ['grant to a public role']],
    ['GRANT SELECT ON woori.users TO PUBLIC;', ['grant to a public role']],
    [
      'GRANT SELECT ON woori.users TO woori_api WITH GRANT OPTION;',
      ['grant select'],
    ],
    [
      'REVOKE ALL ON woori.users FROM woori_api;',
      ['revoke from a public role'],
    ],
    ['ALTER ROLE woori_api BYPASSRLS;', ['alter role']],
    [
      'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon;',
      ['alter default'],
    ],
    [
      'CREATE OR REPLACE FUNCTION woori.f() RETURNS int AS $f$ SELECT 1 $f$ LANGUAGE sql;',
      ['create or'],
    ],
    [
      'CREATE TRIGGER tr AFTER INSERT ON woori.users FOR EACH ROW EXECUTE FUNCTION woori.f();',
      ['create trigger on existing table'],
    ],
    ['INSERT INTO woori.users (id) VALUES (1);', ['insert']],
    [
      'CREATE TABLE woori.p1 PARTITION OF woori.p FOR VALUES IN (1);',
      ['create table'],
    ],
    // Identifiers that could hide a statement from the rules are refused.
    [
      'ALTER TABLE woori.users ALTER COLUMN 이름 TYPE text;',
      ['non-ASCII outside a string'],
    ],
    [
      'ALTER TABLE woori.users ADD COLUMN "a b" INT;',
      ['unusual quoted identifier'],
    ],
    [
      'ALTER TABLE woori.users ADD COLUMN "a""b" INT;',
      ['unusual quoted identifier'],
    ],
    [`SELECT '--'; DROP TABLE x;`, ["select 's'", 'drop table']],
    [`SELECT E'\\'--'; TRUNCATE t;`, ["select 's'", 'truncate t']],
    ["SELECT 'open", ['unreadable (open quote or comment)']],
    ['/* open comment', ['unreadable (open quote or comment)']],
    ['DO $$ BEGIN', ['unreadable (open quote or comment)']],
  ] as const)
    assert.deepEqual(kinds(sql), expected, sql);
  // An empty file is not an automatic migration either.
  assert.equal(one('-- nothing').automatic, false);
  assert.deepEqual(normalizeStatements("SELECT 1; -- x\nSELECT '--y';"), [
    { text: 'SELECT 1', unreadable: null },
    { text: "SELECT 'S'", unreadable: null },
  ]);
});

test('repository migrations: which ones the automatic path accepts is fixed here', () => {
  const dir = join(__dirname, '../../prisma/migrations');
  const migrations = readdirSync(dir)
    .filter(isMigrationName)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8'),
    }));
  // Each judged alone (only its own new tables count as empty).
  const verdicts = Object.fromEntries(
    migrations.map((m) => {
      const [v] = classifyMigrations([m]);
      const reasons = [
        ...new Set(v.statements.filter((s) => !s.allowed).map((s) => s.kind)),
      ];
      return [m.name, v.automatic ? 'auto' : reasons.join(' | ')];
    })
  );
  assert.deepEqual(verdicts, {
    '20261013000000_initial': 'auto',
    '20261013010000_auth_invitations': 'auto',
    '20261014000000_album_media_uploads':
      'drop index | create index on existing table | alter table: add constraint check',
    '20261015000000_media_cleanup_jobs': 'auto',
    '20261018000000_web_push':
      'alter table: add column, add column, add column, add column, add constraint foreign key | update woori.push_installations | create index on existing table',
    '20261019000000_photo_memories': 'create index on existing table',
    '20261020000000_photo_processing_queue': 'create index on existing table',
    '20261021000000_account_settings': 'auto',
    '20261022000000_service_support': 'auto',
    '20261023000000_content_reports': 'auto',
    '20261024000000_user_blocks': 'auto',
    '20261025000000_notification_erasure_indexes':
      'create index on existing table',
    '20261026000000_admin_operations': 'auto',
    '20261027000000_admin_content_operations':
      'create index on existing table | alter table: add constraint check',
    '20261028000000_admin_member_operations': 'create index on existing table',
    '20261029000000_notification_bundles': 'create index on existing table',
    '20261030000000_video_media':
      'alter table: add constraint check | alter table: drop constraint, add constraint check',
    '20261030010000_one_waiting_delivery':
      'update "woori"."notification_deliveries" | create index on existing table',
    '20261031000000_mail_outbox_monitoring': 'auto',
    '20261101000000_member_nickname':
      'update woori.users | alter table: set not null | alter table: add constraint check',
    '20261102000000_neutral_member_copy': 'update woori.users',
    // CHECK constraints on the existing users table scan it under an
    // exclusive lock: the pending avatar migration needs the manual procedure.
    '20261103000000_profile_avatar': 'alter table: add constraint check',
  });
  // The initial migration as a batch with later ones: tables created earlier
  // in the same batch are empty, so later indexes on them are fine.
  const batch = classifyMigrations(migrations.slice(0, 5));
  assert.equal(batch[0].automatic, true);
});

const local = [
  { name: '20261101000000_a', sql: 'CREATE TABLE a (id INT);\n' },
  { name: '20261102000000_b', sql: 'ALTER TABLE a ADD COLUMN b INT;\n' },
  { name: '20261103000000_c', sql: 'CREATE TABLE c (id INT);\n' },
];
const row = (
  name: string,
  sql: string | null,
  finished = true,
  rolledBack = false
) => ({
  migration_name: name,
  checksum: sql === null ? null : migrationChecksum(sql),
  finished,
  rolled_back: rolledBack,
});

test('ledger plan: pending, failed, changed, ahead, out-of-order and manual migrations', () => {
  const upToB = [
    row(local[0].name, local[0].sql),
    row(local[1].name, local[1].sql),
  ];
  const plan = ledgerPlan(local, upToB);
  assert.deepEqual(plan.pending, ['20261103000000_c']);
  assert.deepEqual(plan.pendingChecksums, [migrationChecksum(local[2].sql)]);
  assert.equal(plan.applied, 2);
  assert.equal(plan.latest, '20261103000000_c');
  assert.deepEqual(plan.manual, []);
  assert.deepEqual(ledgerDecision(plan), { code: DB_OK, reason: 'pending' });

  const all = [...upToB, row(local[2].name, local[2].sql)];
  assert.deepEqual(ledgerPlan(local, all).pending, []);
  assert.equal(ledgerDecision(ledgerPlan(local, all)).reason, 'up to date');

  // Prisma accepts the other line endings; any other change is a problem.
  assert.ok(checksumMatches('a\r\nb\r\n', migrationChecksum('a\nb\n')));
  assert.ok(!checksumMatches('a\nb\n', null));
  const changed = ledgerPlan(local, [
    row(local[0].name, 'CREATE TABLE a (id BIGINT);\n'),
    row(local[1].name, local[1].sql),
  ]);
  assert.deepEqual(changed.checksumMismatch, ['20261101000000_a']);
  assert.equal(ledgerDecision(changed).code, DB_LEDGER_PROBLEM);

  // A failed attempt blocks until resolved; one rolled back and re-applied does not.
  const failed = ledgerPlan(local, [
    ...upToB,
    row(local[2].name, local[2].sql, false),
  ]);
  assert.deepEqual(failed.failed, ['20261103000000_c']);
  assert.equal(ledgerDecision(failed).code, DB_LEDGER_PROBLEM);
  const retried = ledgerPlan(local, [
    ...all,
    row(local[2].name, local[2].sql, false, true),
  ]);
  assert.equal(ledgerDecision(retried).code, DB_OK);

  // An older image on a newer database (rollback) is fine on its own...
  const older = ledgerPlan(local.slice(0, 2), all);
  assert.deepEqual(older.unknownApplied, ['20261103000000_c']);
  assert.equal(ledgerDecision(older).code, DB_OK);
  // ...but not with pending migrations of its own, or out of order.
  const diverged = ledgerPlan(local.slice(0, 2), [
    row(local[0].name, local[0].sql),
    row(local[2].name, local[2].sql),
  ]);
  assert.equal(ledgerDecision(diverged).code, DB_LEDGER_PROBLEM);
  const gap = ledgerPlan(local, [
    row(local[0].name, local[0].sql),
    row(local[2].name, local[2].sql),
  ]);
  assert.deepEqual(gap.outOfOrder, ['20261102000000_b']);
  assert.equal(ledgerDecision(gap).code, DB_LEDGER_PROBLEM);

  // A pending statement outside the allowlist sends the batch to the manual
  // procedure; once it is applied by hand, the rest continues automatically.
  const withDrop = [
    ...local,
    { name: '20261104000000_d', sql: 'ALTER TABLE a DROP COLUMN b;' },
  ];
  const manual = ledgerPlan(withDrop, all);
  assert.deepEqual(manual.manual, [
    {
      name: '20261104000000_d',
      kind: 'alter table: drop column',
      text: 'ALTER TABLE A DROP COLUMN B',
    },
  ]);
  assert.equal(ledgerDecision(manual).code, DB_MANUAL);
  const afterManual = ledgerPlan(withDrop, [
    ...all,
    row(withDrop[3].name, withDrop[3].sql),
  ]);
  assert.equal(ledgerDecision(afterManual).code, DB_OK);
  // Tables created by an earlier pending migration in the batch are empty.
  const batch = ledgerPlan(
    [
      ...local,
      { name: '20261104000000_e', sql: 'CREATE INDEX c_id ON c(id);' },
    ],
    upToB
  );
  assert.deepEqual(batch.manual, []);
});

test('plan hash binds the approval to the exact pending set and grants change', () => {
  const base = {
    mode: 'ledger' as const,
    migrations: [{ name: '20261103000000_c', checksum: 'a'.repeat(64) }],
    grants: 'b'.repeat(64),
  };
  const hash = planHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(planHash({ ...base }), hash);
  for (const other of [
    { ...base, mode: 'unknown' as const },
    { ...base, migrations: [] },
    {
      ...base,
      migrations: [{ name: '20261103000000_c', checksum: 'c'.repeat(64) }],
    },
    { ...base, grants: null },
  ])
    assert.notEqual(planHash(other), hash);
});

test('runner summary: added migrations, grants changes and an unknown running release need approval', () => {
  const deployed = [local[0].name, local[1].name];
  assert.deepEqual(
    releaseDbChanges({
      target: local.slice(0, 2),
      deployed,
      grantsChanged: false,
    }),
    {
      dbChanges: false,
      reasons: [],
      added: [],
      manual: [],
      latest: '20261102000000_b',
    }
  );
  const added = releaseDbChanges({
    target: local,
    deployed,
    grantsChanged: false,
  });
  assert.equal(added.dbChanges, true);
  assert.deepEqual(added.reasons, ['migrations-added']);
  assert.deepEqual(added.added, ['20261103000000_c']);
  assert.deepEqual(
    releaseDbChanges({
      target: local.slice(0, 2),
      deployed,
      grantsChanged: null,
    }).reasons,
    ['runtime-grants-changed']
  );
  // Rolling back to an older commit adds nothing.
  assert.deepEqual(
    releaseDbChanges({
      target: local.slice(0, 1),
      deployed,
      grantsChanged: false,
    }).added,
    []
  );
  const unknown = releaseDbChanges({
    target: local,
    deployed: null,
    grantsChanged: null,
  });
  assert.deepEqual(unknown.reasons, ['running-release-unknown']);
  const manual = releaseDbChanges({
    target: [...local, { name: '20261104000000_d', sql: 'TRUNCATE a;' }],
    deployed,
    grantsChanged: false,
  });
  assert.deepEqual(
    manual.manual.map((m) => [m.name, m.kind]),
    [['20261104000000_d', 'truncate a']]
  );
});
