import { randomUUID } from 'node:crypto';
import { length } from 'class-validator';
import { isPlainText } from '../../common/decorators/plain-text.decorator';
import { hashPassword } from '../../domain/auth/password';
import {
  adminAuditMetadata,
  type AdminAuditAction,
  type AdminAuditMetadata,
} from '../admin-audit';
import {
  ADMIN_DISPLAY_NAME_MAX_LENGTH,
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_USERNAME_PATTERN,
} from '../admin-policy';
// Owner-connection operations behind scripts/admin-accounts.mjs. The runtime
// API role cannot create, enable/disable or MFA-reset admin accounts.
export interface OwnerQueryClient {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export class AdminCliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type AdminCliCommand = 'create' | 'reset-mfa' | 'disable' | 'enable';
export interface AdminCliOptions {
  command: AdminCliCommand;
  username: string;
  displayName?: string;
  confirmDatabase: string;
  passwordStdin: boolean;
}
const COMMANDS: AdminCliCommand[] = [
  'create',
  'reset-mfa',
  'disable',
  'enable',
];
// Passwords are never accepted as argv values (shell history, process list).
export function parseAdminCliArgs(argv: string[]): AdminCliOptions {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as AdminCliCommand))
    throw new AdminCliError('USAGE');
  const values = new Map<string, string>();
  let passwordStdin = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--password-stdin' && command === 'create' && !passwordStdin)
      passwordStdin = true;
    else if (
      ['--username', '--confirm-database'].includes(flag) ||
      (flag === '--display-name' && command === 'create')
    ) {
      const value = rest[i + 1];
      if (values.has(flag) || value === undefined || value.startsWith('--'))
        throw new AdminCliError('USAGE');
      values.set(flag, value);
      i++;
    } else throw new AdminCliError('USAGE');
  }
  const username = normalizeAdminUsername(values.get('--username'));
  const confirmDatabase = values.get('--confirm-database');
  if (!confirmDatabase) throw new AdminCliError('USAGE');
  const options: AdminCliOptions = {
    command: command as AdminCliCommand,
    username,
    confirmDatabase,
    passwordStdin,
  };
  if (command === 'create')
    options.displayName = validateAdminDisplayName(
      values.get('--display-name')
    );
  return options;
}
export function normalizeAdminUsername(value: unknown) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ADMIN_USERNAME_PATTERN.test(username))
    throw new AdminCliError('INVALID_USERNAME');
  return username;
}
export function validateAdminDisplayName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!isPlainText(name, 1, ADMIN_DISPLAY_NAME_MAX_LENGTH, false))
    throw new AdminCliError('INVALID_DISPLAY_NAME');
  return name;
}
// Same length rule as the login DTO, plus no control characters.
export function validateAdminPassword(value: unknown) {
  if (
    typeof value !== 'string' ||
    !length(value, ADMIN_PASSWORD_MIN_LENGTH, ADMIN_PASSWORD_MAX_LENGTH) ||
    /\p{Cc}/u.test(value)
  )
    throw new AdminCliError('INVALID_PASSWORD');
  return value;
}
// The database the owner URL points at; --confirm-database must equal it.
export function targetDatabaseName(connectionString: string | undefined) {
  try {
    const url = new URL(connectionString ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!name || name.includes('/')) throw new Error();
    return name;
  } catch {
    throw new AdminCliError('DATABASE_NOT_CONFIGURED');
  }
}
async function transaction<T>(
  client: OwnerQueryClient,
  work: () => Promise<T>
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
async function audit(
  client: OwnerQueryClient,
  adminId: string,
  action: AdminAuditAction,
  metadata: AdminAuditMetadata = {}
) {
  await client.query(
    `INSERT INTO woori.admin_audit_logs (id,"adminId",action,"targetType","targetId",metadata) VALUES ($1::uuid,$2::uuid,$3,'ADMIN',$2::uuid,$4::jsonb)`,
    [
      randomUUID(),
      adminId,
      action,
      JSON.stringify(adminAuditMetadata(metadata)),
    ]
  );
}
async function lockByUsername(client: OwnerQueryClient, username: string) {
  const result = await client.query(
    'SELECT id,status FROM woori.admin_accounts WHERE username=$1 FOR UPDATE',
    [username]
  );
  const row = result.rows[0] as { id: string; status: string } | undefined;
  if (!row) throw new AdminCliError('ADMIN_NOT_FOUND');
  return row;
}
async function revokeSessions(client: OwnerQueryClient, adminId: string) {
  const result = await client.query(
    'UPDATE woori.admin_sessions SET "revokedAt"=now() WHERE "adminId"=$1::uuid AND "revokedAt" IS NULL',
    [adminId]
  );
  return result.rowCount ?? 0;
}
export async function createAdminAccount(
  client: OwnerQueryClient,
  input: { username: string; displayName: string; password: string }
) {
  const username = normalizeAdminUsername(input.username);
  const displayName = validateAdminDisplayName(input.displayName);
  const passwordHash = await hashPassword(
    validateAdminPassword(input.password)
  );
  const id = randomUUID();
  try {
    await transaction(client, async () => {
      await client.query(
        'INSERT INTO woori.admin_accounts (id,username,"displayName","passwordHash") VALUES ($1::uuid,$2,$3,$4)',
        [id, username, displayName, passwordHash]
      );
      await audit(client, id, 'ADMIN_CREATED_BY_CLI');
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new AdminCliError('USERNAME_TAKEN');
    throw error;
  }
  return { id, username };
}
// Clears the TOTP enrolment so the admin enrols again at next login, and ends
// every session of that admin.
export function resetAdminMfa(client: OwnerQueryClient, username: string) {
  return transaction(client, async () => {
    const admin = await lockByUsername(
      client,
      normalizeAdminUsername(username)
    );
    await client.query(
      'UPDATE woori.admin_accounts SET "totpSecretCiphertext"=NULL,"totpEnabledAt"=NULL,"totpLastUsedStep"=NULL WHERE id=$1::uuid',
      [admin.id]
    );
    const revokedSessions = await revokeSessions(client, admin.id);
    await audit(client, admin.id, 'ADMIN_MFA_RESET_BY_CLI', {
      revokedSessions,
    });
    return { id: admin.id, revokedSessions };
  });
}
// Enabling also clears a lockout; disabling ends every session.
export function setAdminStatus(
  client: OwnerQueryClient,
  username: string,
  status: 'ACTIVE' | 'DISABLED'
) {
  return transaction(client, async () => {
    const admin = await lockByUsername(
      client,
      normalizeAdminUsername(username)
    );
    await client.query(
      `UPDATE woori.admin_accounts SET status=$2::woori."AdminStatus"${status === 'ACTIVE' ? ',"failedLoginCount"=0,"lockedUntil"=NULL' : ''} WHERE id=$1::uuid`,
      [admin.id, status]
    );
    const revokedSessions = await revokeSessions(client, admin.id);
    await audit(
      client,
      admin.id,
      status === 'ACTIVE' ? 'ADMIN_ENABLED_BY_CLI' : 'ADMIN_DISABLED_BY_CLI',
      { previousStatus: admin.status, status, revokedSessions }
    );
    return {
      id: admin.id,
      previousStatus: admin.status,
      status,
      revokedSessions,
    };
  });
}
// Fixed, value-free messages: driver errors can contain connection strings.
export function adminCliErrorMessage(error: unknown) {
  const code = error instanceof AdminCliError ? error.code : 'FAILED';
  const messages: Record<string, string> = {
    USAGE:
      '사용법: pnpm admin:create --username <아이디> --display-name <이름> --confirm-database <DB 이름> [--password-stdin]\n' +
      '        pnpm admin:reset-mfa|admin:disable|admin:enable --username <아이디> --confirm-database <DB 이름>',
    INVALID_USERNAME: '관리자 아이디는 영문 소문자·숫자·_ 3~32자여야 합니다.',
    INVALID_DISPLAY_NAME: '표시 이름은 제어 문자 없이 1~80자여야 합니다.',
    INVALID_PASSWORD: `비밀번호는 제어 문자 없이 ${ADMIN_PASSWORD_MIN_LENGTH}~${ADMIN_PASSWORD_MAX_LENGTH}자여야 합니다.`,
    PASSWORD_MISMATCH: '두 번 입력한 비밀번호가 다릅니다.',
    PASSWORD_INPUT_REQUIRED:
      '비밀번호는 터미널 입력(화면에 표시되지 않음) 또는 --password-stdin 한 줄로만 받습니다.',
    DATABASE_NOT_CONFIGURED:
      'MIGRATION_DATABASE_URL(소유자 연결)이 설정되지 않았거나 올바르지 않습니다.',
    DATABASE_NOT_CONFIRMED:
      '--confirm-database 값이 MIGRATION_DATABASE_URL의 DB 이름과 다릅니다. 대상 DB를 확인하세요.',
    USERNAME_TAKEN: '이미 사용 중인 관리자 아이디입니다.',
    ADMIN_NOT_FOUND: '관리자 계정을 찾을 수 없습니다.',
    FAILED:
      '관리자 계정 작업에 실패했습니다. pnpm build, DB 연결과 마이그레이션 적용 상태를 확인하세요. 비밀값 보호를 위해 원문 오류는 출력하지 않습니다.',
  };
  return messages[code] ?? messages.FAILED;
}
