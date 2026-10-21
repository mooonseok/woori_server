// Pure helpers for the production database gate of an automatic deployment.
// The API host decides (scripts/release-db.mjs, against the real migration
// ledger); the GitHub runner only summarises (scripts/deploy-plan.mjs). A
// migration takes the automatic path (after a person approved the exact
// pending set) only when every statement matches the allowlist below: forms
// that add objects or metadata without rewriting, scanning or locking existing
// rows for long. Anything else — including forms this file does not know —
// stays with the manual procedure (SETUP.md "운영 migration 절차"); once it is
// applied by hand it is no longer pending and deployments continue on their
// own. Git, DB and file IO stay in the scripts.
import { createHash } from 'node:crypto';

export const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;
export const isMigrationName = (value: unknown): value is string =>
  typeof value === 'string' && MIGRATION_NAME.test(value);

export interface MigrationSource {
  name: string;
  sql: string;
}

export const sha256Hex = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

// Prisma stores the sha256 (hex) of migration.sql in _prisma_migrations and
// also accepts the file with the other line endings.
export const migrationChecksum = sha256Hex;

export function checksumMatches(sql: string, recorded: string | null) {
  if (!recorded) return false;
  const lf = sql.replaceAll('\r\n', '\n');
  return [sql, lf, lf.replaceAll('\n', '\r\n')].some(
    (variant) => migrationChecksum(variant) === recorded
  );
}

export interface NormalizedStatement {
  // Comments removed, whitespace collapsed, unquoted words upper-cased,
  // string literals as 'S', dollar-quoted bodies as $BODY$, simple quoted
  // identifiers kept as "name".
  text: string;
  // Why the statement can never match the allowlist, before any rule.
  unreadable: string | null;
}

// Splits SQL into statements the way PostgreSQL reads them (quotes, E''
// strings, dollar quotes, nested block comments). Returns null when a quote or
// comment is left open.
export function normalizeStatements(sql: string): NormalizedStatement[] | null {
  const statements: NormalizedStatement[] = [];
  let text = '';
  let unreadable: string | null = null;
  const word = (char: string | undefined) => !!char && /[\w$]/.test(char);
  const flush = () => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed) statements.push({ text: trimmed, unreadable });
    text = '';
    unreadable = null;
  };
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      text += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return null;
      text += ' ';
      continue;
    }
    if (char === "'") {
      // E'…' strings also escape with a backslash.
      const backslash = /[eE]/.test(sql[i - 1] ?? '') && !word(sql[i - 2]);
      if (backslash) text = text.slice(0, -1);
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (backslash && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      text += "'S'";
      i = j + 1;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      const name = sql.slice(i + 1, j);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        unreadable ??= 'unusual quoted identifier';
      text += `"${name}"`;
      i = j + 1;
      continue;
    }
    if (char === '$' && !word(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return null;
        text += '$BODY$';
        i = end + tag.length;
        continue;
      }
    }
    if (char === ';') {
      flush();
      i++;
      continue;
    }
    if (/[^\x20-\x7e\t\r\n]/.test(char))
      unreadable ??= 'non-ASCII outside a string';
    text += char.toUpperCase();
    i++;
  }
  flush();
  return statements;
}

const Q = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Z_][A-Z0-9_]*)';
const QN = `${Q}(?:\\.${Q})?`;
const re = (source: string) => new RegExp(`^${source}$`);

// "woori"."users" and woori.users name the same table.
export function canonicalName(name: string) {
  return name
    .split('.')
    .map((part) =>
      part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()
    )
    .join('.');
}

// Top-level comma split (parentheses balanced).
function splitTopLevel(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

const balanced = (text: string) => {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
};

// A DEFAULT that PostgreSQL stores as metadata for existing rows (no rewrite).
const CONSTANT = re(
  `(?:'S'(?: ?:: ?${QN}(?: ?\\([0-9, ]+\\))?(?:\\[\\])?)?|-?[0-9]+(?:\\.[0-9]+)?|TRUE|FALSE|NULL|CURRENT_TIMESTAMP|CURRENT_DATE)`
);
const PUBLIC_ROLES = /^(?:PUBLIC|ANON|AUTHENTICATED|SERVICE_ROLE)$/;

export interface StatementVerdict {
  kind: string;
  allowed: boolean;
  // Short, value-free description (string literals are already 'S').
  text: string;
}

// One ALTER TABLE action on table (canonical) given the tables this batch of
// pending migrations creates.
function alterAction(action: string, isNew: boolean): [string, boolean] {
  if (action === 'ENABLE ROW LEVEL SECURITY')
    return ['enable row level security', isNew];
  // Checks a NOT VALID constraint without blocking writes.
  if (re(`VALIDATE CONSTRAINT ${Q}`).test(action))
    return ['validate constraint', true];
  let m = re(
    `ADD CONSTRAINT ${Q} (CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY) ?\\(.*`
  ).exec(action);
  if (m) {
    if (/\$BODY\$/.test(action)) return ['add constraint', false];
    const notValid = / NOT VALID$/.test(action);
    const kind = `add constraint ${m[1].toLowerCase()}`;
    if (isNew) return [kind, true];
    // NOT VALID skips the scan of existing rows (CHECK and FOREIGN KEY only).
    return [kind, notValid && (m[1] === 'CHECK' || m[1] === 'FOREIGN KEY')];
  }
  m = re(`ADD COLUMN (?:IF NOT EXISTS )?${Q} (.+)`).exec(action);
  if (m) {
    if (isNew) return ['add column', true];
    const rest = m[1];
    if (
      /\b(?:REFERENCES|CHECK|UNIQUE|PRIMARY|GENERATED|CONSTRAINT|COLLATE)\b|\$BODY\$/.test(
        rest
      )
    )
      return ['add column with constraint', false];
    const notNull = / NOT NULL\b/.test(rest);
    const defaultExpr = / DEFAULT (.+?)(?: NOT NULL| NULL)?$/.exec(rest)?.[1];
    if (defaultExpr !== undefined && !CONSTANT.test(defaultExpr))
      return ['add column with a computed default', false];
    if (notNull && defaultExpr === undefined)
      return ['add column not null without default', false];
    return ['add column', true];
  }
  m = re(`ALTER (?:COLUMN )?${Q} (.+)`).exec(action);
  if (m) {
    const change = m[1];
    if (/^SET DEFAULT .+/.test(change) && !/\$BODY\$/.test(change))
      return ['set default', true];
    if (change === 'DROP DEFAULT') return ['drop default', true];
    if (change === 'DROP NOT NULL') return ['drop not null', true];
    if (change === 'SET NOT NULL') return ['set not null', false];
    if (/^(?:SET DATA )?TYPE /.test(change))
      return ['alter column type', false];
    return ['alter column', false];
  }
  return [action.split(' ').slice(0, 2).join(' ').toLowerCase(), false];
}

function verdict(
  statement: string,
  newTables: Set<string>,
  sole: boolean
): StatementVerdict {
  const text =
    statement.length > 120 ? `${statement.slice(0, 117)}...` : statement;
  const result = (kind: string, allowed: boolean) => ({ kind, allowed, text });
  let m: RegExpExecArray | null;
  if (re(`CREATE SCHEMA IF NOT EXISTS ${Q}`).test(statement))
    return result('create schema', true);
  if (re(`CREATE TYPE ${QN} AS ENUM ?\\('S'(?: ?, ?'S')*\\)`).test(statement))
    return result('create enum type', true);
  if (
    re(
      `ALTER TYPE ${QN} ADD VALUE (?:IF NOT EXISTS )?'S'(?: (?:BEFORE|AFTER) 'S')?`
    ).test(statement)
  )
    return result('add enum value', true);
  if (
    (m = re(`CREATE TABLE (?:IF NOT EXISTS )?(${QN}) ?\\((.*)\\)`).exec(
      statement
    ))
  ) {
    const ok =
      balanced(m[2]) && !/\$BODY\$|\bPARTITION\b|\bINHERITS\b/.test(m[2]);
    if (ok) newTables.add(canonicalName(m[1]));
    return result('create table', ok);
  }
  if (
    (m = re(
      `CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${Q} ON (?:ONLY )?(${QN})(?: USING ${Q})? ?\\(.*\\)(?: WHERE .+)?`
    ).exec(statement))
  ) {
    // On an existing table a plain CREATE INDEX blocks writes while it builds.
    const isNew = newTables.has(canonicalName(m[1]));
    return result(
      isNew ? 'create index' : 'create index on existing table',
      isNew
    );
  }
  // CONCURRENTLY does not block writes but cannot run inside a transaction, so
  // Prisma can apply it only as the migration's single statement.
  if (
    re(
      `CREATE (?:UNIQUE )?INDEX CONCURRENTLY (?:IF NOT EXISTS )?${Q} ON (?:ONLY )?${QN}(?: USING ${Q})? ?\\(.*\\)(?: WHERE .+)?`
    ).test(statement)
  )
    return result(
      sole
        ? 'create index concurrently'
        : 'create index concurrently (not alone)',
      sole
    );
  if ((m = re(`ALTER TABLE (?:ONLY )?(${QN}) (.+)`).exec(statement))) {
    const isNew = newTables.has(canonicalName(m[1]));
    const actions = splitTopLevel(m[2]).map((a) => alterAction(a, isNew));
    const denied = actions.find(([, allowed]) => !allowed);
    return result(
      `alter table: ${actions.map(([kind]) => kind).join(', ')}`,
      !denied
    );
  }
  if (
    re(
      `COMMENT ON (?:TABLE|COLUMN|TYPE|INDEX|SCHEMA) ${QN}(?:\\.${Q})? IS (?:'S'|NULL)`
    ).test(statement)
  )
    return result('comment', true);
  if (
    (m = re(
      `REVOKE (?:ALL|[A-Z, ]+) ON (?:SCHEMA ${Q}|ALL TABLES IN SCHEMA ${Q}|(?:TABLE )?${QN}) FROM (${Q})`
    ).exec(statement))
  ) {
    // Only public roles lose access; the runtime role keeps its own grants.
    return result('revoke from a public role', PUBLIC_ROLES.test(m[1]));
  }
  if (
    (m = re(
      `GRANT [A-Za-z0-9, ()"_]+ ON (?:SCHEMA ${Q}|(?:TABLE )?${QN}(?:, ?${QN})*|FUNCTION ${QN} ?\\([^)]*\\)) TO (${Q})`
    ).exec(statement))
  )
    return result(
      PUBLIC_ROLES.test(m[1]) ? 'grant to a public role' : 'grant',
      !PUBLIC_ROLES.test(m[1])
    );
  if (
    (m = re(
      `CREATE TRIGGER ${Q} (?:BEFORE|AFTER) [A-Za-z0-9 ,"_]+ ON (${QN}) FOR EACH (?:ROW|STATEMENT)(?: WHEN \\(.*\\))? EXECUTE (?:FUNCTION|PROCEDURE) ${QN} ?\\(\\)`
    ).exec(statement))
  ) {
    const isNew = newTables.has(canonicalName(m[1]));
    return result(
      isNew ? 'create trigger' : 'create trigger on existing table',
      isNew
    );
  }
  if (
    (m = re(`INSERT INTO (${QN})(?: ?\\(.*?\\))? VALUES .+`).exec(statement))
  ) {
    const isNew =
      newTables.has(canonicalName(m[1])) && !/\$BODY\$/.test(statement);
    return result(isNew ? 'insert into new table' : 'insert', isNew);
  }
  return result(
    statement.split(' ').slice(0, 2).join(' ').toLowerCase(),
    false
  );
}

export interface MigrationVerdict {
  name: string;
  automatic: boolean;
  statements: StatementVerdict[];
}

// A batch in apply order; tables created earlier in the batch are empty, so
// indexes, constraints and RLS on them are safe.
export function classifyMigrations(
  migrations: MigrationSource[]
): MigrationVerdict[] {
  const newTables = new Set<string>();
  return migrations.map(({ name, sql }) => {
    const parsed = normalizeStatements(sql);
    if (parsed === null)
      return {
        name,
        automatic: false,
        statements: [
          {
            kind: 'unreadable (open quote or comment)',
            allowed: false,
            text: '',
          },
        ],
      };
    const statements = parsed.map((s) =>
      s.unreadable
        ? { kind: s.unreadable, allowed: false, text: s.text.slice(0, 120) }
        : verdict(s.text, newTables, parsed.length === 1)
    );
    return {
      name,
      automatic: statements.length > 0 && statements.every((s) => s.allowed),
      statements,
    };
  });
}

// The statements that keep a batch off the automatic path.
export const manualStatements = (verdicts: MigrationVerdict[]) =>
  verdicts.flatMap((v) =>
    v.statements
      .filter((s) => !s.allowed)
      .map((s) => ({ name: v.name, kind: s.kind, text: s.text }))
  );

const sortedNames = (migrations: MigrationSource[]) =>
  migrations.map((m) => m.name).sort();

export type DbChangeReason =
  'running-release-unknown' | 'migrations-added' | 'runtime-grants-changed';

// Runner side (summary only): what the target commit changes compared with the
// release /healthz reports as running. deployed=null (unknown) counts as a
// change; the API host plan is what the approval is bound to.
export function releaseDbChanges(input: {
  target: MigrationSource[];
  deployed: string[] | null;
  grantsChanged: boolean | null;
}) {
  const latest = sortedNames(input.target).at(-1) ?? null;
  if (input.deployed === null)
    return {
      dbChanges: true,
      reasons: ['running-release-unknown'] as DbChangeReason[],
      added: [] as string[],
      manual: [] as ReturnType<typeof manualStatements>,
      latest,
    };
  const known = new Set(input.deployed);
  const added = [...input.target]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((m) => !known.has(m.name));
  const reasons: DbChangeReason[] = [];
  if (added.length) reasons.push('migrations-added');
  if (input.grantsChanged !== false) reasons.push('runtime-grants-changed');
  return {
    dbChanges: reasons.length > 0,
    reasons,
    added: added.map((m) => m.name),
    manual: manualStatements(classifyMigrations(added)),
    latest,
  };
}

export interface LedgerRow {
  migration_name: string;
  checksum: string | null;
  finished: boolean;
  rolled_back: boolean;
}

// Host side: this image's migrations against _prisma_migrations. A migration is
// applied when a row finished and was not rolled back (as Prisma counts it).
export function ledgerPlan(local: MigrationSource[], rows: LedgerRow[]) {
  const sorted = [...local].sort((a, b) => a.name.localeCompare(b.name));
  const names = sorted.map((m) => m.name);
  const applied = new Map<string, string | null>();
  for (const row of rows)
    if (row.finished && !row.rolled_back)
      applied.set(row.migration_name, row.checksum);
  const failed = [
    ...new Set(
      rows
        .filter(
          (row) =>
            !row.finished &&
            !row.rolled_back &&
            !applied.has(row.migration_name)
        )
        .map((row) => row.migration_name)
    ),
  ].sort();
  const pending = sorted.filter((m) => !applied.has(m.name));
  const newestApplied = names.filter((name) => applied.has(name)).at(-1);
  return {
    applied: applied.size,
    pending: pending.map((m) => m.name),
    pendingChecksums: pending.map((m) => migrationChecksum(m.sql)),
    failed,
    checksumMismatch: sorted
      .filter(
        (m) =>
          applied.has(m.name) && !checksumMatches(m.sql, applied.get(m.name)!)
      )
      .map((m) => m.name),
    // In the ledger but not in this image: the database is ahead (an older
    // image, e.g. a rollback). Additive migrations stay; that is allowed alone.
    unknownApplied: [...applied.keys()]
      .filter((name) => !names.includes(name))
      .sort(),
    // Pending yet older than an applied migration: would run out of order.
    outOfOrder: newestApplied
      ? pending.map((m) => m.name).filter((name) => name < newestApplied)
      : [],
    latest: names.at(-1) ?? null,
    manual: manualStatements(classifyMigrations(pending)),
  };
}

export type LedgerPlan = ReturnType<typeof ledgerPlan>;

export const DB_OK = 0;
export const DB_NEEDS_APPROVAL = 20;
export const DB_MANUAL = 21;
export const DB_LEDGER_PROBLEM = 22;

// What an approval is bound to. With the ledger readable (read-only role) it is
// the exact pending set and the grants change; without it ("unknown") it is
// the image's whole migration set and grants, and the owner connection finds
// the pending set only after the approval. The host applies only when the
// approved value equals the plan it computes again at that moment.
export function planHash(input: {
  mode: 'ledger' | 'unknown';
  migrations: { name: string; checksum: string }[];
  grants: string | null;
}) {
  return sha256Hex(
    JSON.stringify({
      v: 1,
      mode: input.mode,
      migrations: input.migrations.map((m) => `${m.name}:${m.checksum}`),
      grants: input.grants,
    })
  );
}

export const isPlanHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// Ledger problems first, then statements that need the manual procedure.
export function ledgerDecision(plan: LedgerPlan) {
  if (plan.failed.length)
    return { code: DB_LEDGER_PROBLEM, reason: 'failed migration in ledger' };
  if (plan.checksumMismatch.length)
    return { code: DB_LEDGER_PROBLEM, reason: 'applied migration changed' };
  if (plan.outOfOrder.length)
    return {
      code: DB_LEDGER_PROBLEM,
      reason: 'pending migration out of order',
    };
  if (plan.pending.length && plan.unknownApplied.length)
    return { code: DB_LEDGER_PROBLEM, reason: 'ledger and image diverge' };
  if (plan.manual.length)
    return {
      code: DB_MANUAL,
      reason: 'pending statements need the manual procedure',
    };
  return {
    code: DB_OK,
    reason: plan.pending.length ? 'pending' : 'up to date',
  };
}
