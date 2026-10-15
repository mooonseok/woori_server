import { Injectable } from '@nestjs/common';
import type { AdminAccount, AdminSession, Prisma } from '@prisma/client';
import { PrismaService } from '../common/modules/prisma/prisma.service';
import { writeAdminAudit } from './admin-audit';
import {
  ADMIN_PRE_MFA_SESSION_MS,
  ADMIN_SESSION_ABSOLUTE_MS,
  ADMIN_SESSION_IDLE_MS,
  ADMIN_SESSION_MFA_FAILURE_LIMIT,
  isAdminLocked,
  nextFailureState,
} from './admin-policy';
import type { AdminSessionContext } from './dto/admin-session.dto';
import { decryptTotpSecret, verifyTotp } from './totp';

type Tx = Prisma.TransactionClient;
export type LoginFailureReason =
  'UNKNOWN_ACCOUNT' | 'WRONG_PASSWORD' | 'DISABLED' | 'LOCKED';
export type MfaStage = 'ACTIVATE' | 'VERIFY';
export type AdminMfaOutcome =
  | { kind: 'ok'; context: AdminSessionContext }
  | { kind: 'unauthenticated' }
  | { kind: 'already-verified' }
  | { kind: 'already-enabled' }
  | { kind: 'setup-required' }
  | { kind: 'invalid'; sessionRevoked: boolean };
export type AdminReauthOutcome =
  | { kind: 'ok'; context: AdminSessionContext }
  | { kind: 'unauthenticated' }
  | { kind: 'invalid'; sessionRevoked: boolean };

// Lock order everywhere (API and CLI): admin account row, then session rows.
async function lockAccount(tx: Tx, adminId: string) {
  await tx.$queryRaw`SELECT id FROM woori.admin_accounts WHERE id=${adminId}::uuid FOR UPDATE`;
  return tx.adminAccount.findUnique({ where: { id: adminId } });
}
async function lockSession(tx: Tx, sessionId: string, adminId: string) {
  await tx.$queryRaw`SELECT id FROM woori.admin_sessions WHERE id=${sessionId}::uuid FOR UPDATE`;
  return tx.adminSession.findFirst({ where: { id: sessionId, adminId } });
}
function sessionActive(session: AdminSession | null, now: Date) {
  return Boolean(
    session &&
    !session.revokedAt &&
    session.expiresAt > now &&
    session.idleExpiresAt > now
  );
}
function context(
  account: Pick<
    AdminAccount,
    'id' | 'username' | 'displayName' | 'totpEnabledAt'
  >,
  session: AdminSession
): AdminSessionContext {
  return {
    sessionId: session.id,
    admin: {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
    },
    totpEnabled: Boolean(account.totpEnabledAt),
    mfaVerifiedAt: session.mfaVerifiedAt,
    reauthAt: session.reauthAt,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
  };
}
const self = (adminId: string) => ({
  adminId,
  targetType: 'ADMIN' as const,
  targetId: adminId,
});

@Injectable()
export class AdminAuthRepository {
  constructor(private readonly prisma: PrismaService) {}
  findLoginAccount(username: string) {
    return this.prisma.client.adminAccount.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        displayName: true,
        passwordHash: true,
        status: true,
        totpEnabledAt: true,
        lockedUntil: true,
      },
    });
  }
  // Failed password logins are audited. Only a wrong password for an active,
  // unlocked account counts toward lockout; the attempted username of an unknown
  // account is never stored.
  recordLoginFailure(
    adminId: string | null,
    reason: LoginFailureReason,
    now: Date
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const account = adminId ? await lockAccount(tx, adminId) : null;
      if (!account) {
        await writeAdminAudit(tx, {
          adminId: null,
          action: 'ADMIN_LOGIN_FAILED',
          metadata: { stage: 'LOGIN', reason: 'UNKNOWN_ACCOUNT' },
        });
        return;
      }
      let final = reason;
      let locked = false;
      if (account.status !== 'ACTIVE') final = 'DISABLED';
      else if (isAdminLocked(account.lockedUntil, now)) final = 'LOCKED';
      else if (reason === 'WRONG_PASSWORD') {
        const next = nextFailureState(account, now);
        await tx.adminAccount.update({
          where: { id: account.id },
          data: {
            failedLoginCount: next.failedLoginCount,
            lockedUntil: next.lockedUntil,
          },
          select: { id: true },
        });
        locked = next.locked;
      }
      await writeAdminAudit(tx, {
        ...self(account.id),
        action: 'ADMIN_LOGIN_FAILED',
        metadata: { stage: 'LOGIN', reason: final },
      });
      if (locked)
        await writeAdminAudit(tx, {
          ...self(account.id),
          action: 'ADMIN_LOCKED',
          metadata: { stage: 'LOGIN' },
        });
    });
  }
  // Creates a pre-MFA session only if the account is still active, unlocked and
  // has the password hash that was just verified.
  createPreMfaSession(
    adminId: string,
    expectedPasswordHash: string,
    tokenHash: string,
    previousTokenHash: string | undefined,
    now: Date
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const account = await lockAccount(tx, adminId);
      if (
        !account ||
        account.status !== 'ACTIVE' ||
        account.passwordHash !== expectedPasswordHash ||
        isAdminLocked(account.lockedUntil, now)
      )
        return null;
      if (previousTokenHash)
        await tx.adminSession.updateMany({
          where: { tokenHash: previousTokenHash, revokedAt: null },
          data: { revokedAt: now },
        });
      const expiresAt = new Date(now.getTime() + ADMIN_PRE_MFA_SESSION_MS);
      const session = await tx.adminSession.create({
        data: {
          adminId,
          tokenHash,
          createdAt: now,
          expiresAt,
          idleExpiresAt: expiresAt,
        },
      });
      return context(account, session);
    });
  }
  async findActiveSession(tokenHash: string, now: Date) {
    const session = await this.prisma.client.adminSession.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
        idleExpiresAt: { gt: now },
        admin: { status: 'ACTIVE' },
      },
      include: {
        admin: {
          select: {
            id: true,
            username: true,
            displayName: true,
            totpEnabledAt: true,
          },
        },
      },
    });
    return session ? context(session.admin, session) : null;
  }
  async slideIdleExpiry(sessionId: string, idleExpiresAt: Date) {
    await this.prisma.client.adminSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        idleExpiresAt: { lt: idleExpiresAt },
      },
      data: { idleExpiresAt },
    });
  }
  // Each setup call replaces the pending (not yet activated) secret.
  storePendingTotpSecret(
    session: AdminSessionContext,
    ciphertext: string,
    now: Date
  ) {
    return this.prisma.client.$transaction(async (tx) => {
      const account = await lockAccount(tx, session.admin.id);
      const current = await lockSession(
        tx,
        session.sessionId,
        session.admin.id
      );
      if (
        !account ||
        account.status !== 'ACTIVE' ||
        !sessionActive(current, now)
      )
        return 'unauthenticated' as const;
      if (current!.mfaVerifiedAt) return 'already-verified' as const;
      if (account.totpEnabledAt) return 'already-enabled' as const;
      await tx.adminAccount.update({
        where: { id: account.id },
        data: { totpSecretCiphertext: ciphertext },
        select: { id: true },
      });
      return 'ok' as const;
    });
  }
  // Activation (first enrolment) or verification at login. Success rotates the
  // session token, starts the 8 h absolute / 30 min idle lifetime and counts as
  // a fresh re-authentication. Failures are committed before the caller throws.
  completeMfa(
    stage: MfaStage,
    session: AdminSessionContext,
    code: string,
    encryptionKey: string,
    newTokenHash: string,
    now: Date
  ): Promise<AdminMfaOutcome> {
    return this.prisma.client.$transaction(async (tx) => {
      const adminId = session.admin.id;
      const account = await lockAccount(tx, adminId);
      const current = await lockSession(tx, session.sessionId, adminId);
      if (
        !account ||
        account.status !== 'ACTIVE' ||
        !sessionActive(current, now)
      )
        return { kind: 'unauthenticated' };
      const row = current!;
      if (row.mfaVerifiedAt) return { kind: 'already-verified' };
      if (stage === 'ACTIVATE') {
        if (account.totpEnabledAt) return { kind: 'already-enabled' };
        if (!account.totpSecretCiphertext) return { kind: 'setup-required' };
      } else if (!account.totpEnabledAt || !account.totpSecretCiphertext)
        return { kind: 'setup-required' };
      const wasLocked = isAdminLocked(account.lockedUntil, now);
      const step = wasLocked
        ? null
        : verifyTotp(
            decryptTotpSecret(
              account.totpSecretCiphertext!,
              encryptionKey,
              adminId
            ),
            code,
            now.getTime(),
            account.totpLastUsedStep
          );
      if (step === null) {
        const mfaFailedCount = row.mfaFailedCount + 1;
        let locked = false;
        if (!wasLocked) {
          const next = nextFailureState(account, now);
          await tx.adminAccount.update({
            where: { id: adminId },
            data: {
              failedLoginCount: next.failedLoginCount,
              lockedUntil: next.lockedUntil,
            },
            select: { id: true },
          });
          locked = next.locked;
        }
        const sessionRevoked =
          locked || mfaFailedCount >= ADMIN_SESSION_MFA_FAILURE_LIMIT;
        await tx.adminSession.update({
          where: { id: row.id },
          data: {
            mfaFailedCount,
            ...(sessionRevoked ? { revokedAt: now } : {}),
          },
          select: { id: true },
        });
        await writeAdminAudit(tx, {
          ...self(adminId),
          action: 'ADMIN_MFA_FAILED',
          metadata: {
            stage,
            reason: wasLocked ? 'LOCKED' : 'INVALID_CODE',
            sessionRevoked,
          },
        });
        if (locked)
          await writeAdminAudit(tx, {
            ...self(adminId),
            action: 'ADMIN_LOCKED',
            metadata: { stage },
          });
        return { kind: 'invalid', sessionRevoked };
      }
      const updatedAccount = await tx.adminAccount.update({
        where: { id: adminId },
        data: {
          ...(stage === 'ACTIVATE' ? { totpEnabledAt: now } : {}),
          totpLastUsedStep: BigInt(step),
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          totpEnabledAt: true,
        },
      });
      const updatedSession = await tx.adminSession.update({
        where: { id: row.id },
        data: {
          tokenHash: newTokenHash,
          mfaVerifiedAt: now,
          reauthAt: now,
          mfaFailedCount: 0,
          expiresAt: new Date(now.getTime() + ADMIN_SESSION_ABSOLUTE_MS),
          idleExpiresAt: new Date(now.getTime() + ADMIN_SESSION_IDLE_MS),
        },
      });
      if (stage === 'ACTIVATE')
        await writeAdminAudit(tx, {
          ...self(adminId),
          action: 'ADMIN_MFA_ENABLED',
        });
      await writeAdminAudit(tx, {
        ...self(adminId),
        action: 'ADMIN_LOGIN_SUCCEEDED',
        metadata: { method: stage === 'ACTIVATE' ? 'TOTP_SETUP' : 'TOTP' },
      });
      return { kind: 'ok', context: context(updatedAccount, updatedSession) };
    });
  }
  // Password + TOTP re-authentication on an MFA-verified session. The password
  // was verified by the caller against expectedPasswordHash outside this
  // transaction (scrypt is slow); it must still be the stored hash.
  reauthenticate(
    session: AdminSessionContext,
    expectedPasswordHash: string,
    passwordCorrect: boolean,
    code: string,
    encryptionKey: string,
    now: Date
  ): Promise<AdminReauthOutcome> {
    return this.prisma.client.$transaction(async (tx) => {
      const adminId = session.admin.id;
      const account = await lockAccount(tx, adminId);
      const current = await lockSession(tx, session.sessionId, adminId);
      if (
        !account ||
        account.status !== 'ACTIVE' ||
        !sessionActive(current, now) ||
        !current!.mfaVerifiedAt ||
        !account.totpEnabledAt ||
        !account.totpSecretCiphertext
      )
        return { kind: 'unauthenticated' };
      const row = current!;
      const wasLocked = isAdminLocked(account.lockedUntil, now);
      const passwordOk =
        passwordCorrect && account.passwordHash === expectedPasswordHash;
      const step = wasLocked
        ? null
        : verifyTotp(
            decryptTotpSecret(
              account.totpSecretCiphertext,
              encryptionKey,
              adminId
            ),
            code,
            now.getTime(),
            account.totpLastUsedStep
          );
      if (wasLocked || !passwordOk || step === null) {
        let locked = false;
        if (!wasLocked) {
          const next = nextFailureState(account, now);
          await tx.adminAccount.update({
            where: { id: adminId },
            data: {
              failedLoginCount: next.failedLoginCount,
              lockedUntil: next.lockedUntil,
            },
            select: { id: true },
          });
          locked = next.locked;
        }
        // Reaching the lockout threshold also ends the session that failed.
        if (locked)
          await tx.adminSession.update({
            where: { id: row.id },
            data: { revokedAt: now },
            select: { id: true },
          });
        await writeAdminAudit(tx, {
          ...self(adminId),
          action: 'ADMIN_REAUTH_FAILED',
          metadata: {
            stage: 'REAUTH',
            reason: wasLocked
              ? 'LOCKED'
              : !passwordOk
                ? 'WRONG_PASSWORD'
                : 'INVALID_CODE',
            sessionRevoked: locked,
          },
        });
        if (locked)
          await writeAdminAudit(tx, {
            ...self(adminId),
            action: 'ADMIN_LOCKED',
            metadata: { stage: 'REAUTH' },
          });
        return { kind: 'invalid', sessionRevoked: locked };
      }
      await tx.adminAccount.update({
        where: { id: adminId },
        data: {
          totpLastUsedStep: BigInt(step),
          failedLoginCount: 0,
          lockedUntil: null,
        },
        select: { id: true },
      });
      const updatedSession = await tx.adminSession.update({
        where: { id: row.id },
        data: { reauthAt: now },
      });
      await writeAdminAudit(tx, {
        ...self(adminId),
        action: 'ADMIN_REAUTHENTICATED',
      });
      return { kind: 'ok', context: context(account, updatedSession) };
    });
  }
  revokeSession(sessionId: string, now: Date) {
    return this.prisma.client.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
  // Revokes the cookie's session if it is not revoked yet; an audit row is
  // written only when an active session was ended.
  logout(tokenHash: string, now: Date) {
    return this.prisma.client.$transaction(async (tx) => {
      const session = await tx.adminSession.findUnique({
        where: { tokenHash },
      });
      if (!session || session.revokedAt) return;
      const revoked = await tx.adminSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count === 1 && sessionActive(session, now))
        await writeAdminAudit(tx, {
          ...self(session.adminId),
          action: 'ADMIN_LOGGED_OUT',
        });
    });
  }
}
