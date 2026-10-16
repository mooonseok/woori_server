import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/modules/prisma/prisma.service';
import { mailConfigured, mailOutboxKey } from '../../common/mail/mail-config';
import {
  decryptMailPayload,
  encryptMailPayload,
  type MailPayload,
} from '../../common/mail/mail-crypto';
import {
  MailDeliveryError,
  MailService,
  type MailDeliveryOptions,
} from '../auth/mail.service';

// W07-4 mail outbox. Every auth/recovery/email-change mail is written in the
// transaction that creates its token (no token without a queued mail, no mail
// without its token). The API tries it once right after the commit; the worker
// retries with backoff until it is sent, expired or rejected.
export type MailKind =
  | 'VERIFY_EMAIL'
  | 'RECOVER_USERNAME'
  | 'RESET_PASSWORD'
  | 'CHANGE_EMAIL'
  | 'EMAIL_CHANGED_NOTICE';
const TOKEN_KINDS = new Set<MailKind>([
  'VERIFY_EMAIL',
  'RESET_PASSWORD',
  'CHANGE_EMAIL',
]);
export const MAIL_MAX_ATTEMPTS = 6;
export const MAIL_RETENTION_DAYS = 14;
// No-token mails: a username reminder is useful briefly; the email-changed
// security notice is worth delivering for a day.
export const MAIL_TTL_MS: Record<
  'RECOVER_USERNAME' | 'EMAIL_CHANGED_NOTICE',
  number
> = {
  RECOVER_USERNAME: 30 * 60_000,
  EMAIL_CHANGED_NOTICE: 24 * 60 * 60_000,
};
/** 30 s, 1, 2, 4, 8 min, then 15 min (attempts already made, >= 1). */
export function mailRetryDelayMs(attempts: number) {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export function mailUnavailable() {
  return new ServiceUnavailableException({
    code: 'MAIL_DELIVERY_UNAVAILABLE',
    message: '메일을 보내지 못했어요. 잠시 후 다시 요청해 주세요.',
  });
}
/** Throws 503 before any token is created when mail cannot be delivered. */
export function requireMailConfigured() {
  if (!mailConfigured()) throw mailUnavailable();
}

/** Inside the transaction that creates the token (or the account change). */
export async function enqueueMail(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    kind: MailKind;
    userId: string;
    emailTokenId?: string;
    payload: MailPayload;
    expiresAt: Date;
  }
) {
  const key = mailOutboxKey();
  if (!key) throw mailUnavailable();
  if (TOKEN_KINDS.has(input.kind) !== Boolean(input.emailTokenId))
    throw new Error('Token-backed mail requires its token');
  await tx.mailOutbox.create({
    data: {
      id: input.id,
      kind: input.kind,
      userId: input.userId,
      emailTokenId: input.emailTokenId ?? null,
      payload: encryptMailPayload(input.payload, key, input.id),
      expiresAt: input.expiresAt,
      nextAttemptAt: new Date(),
    },
  });
}

export type MailClaim = {
  id: string;
  kind: MailKind;
  userId: string;
  emailTokenId: string | null;
  payload: string | null;
  attempts: number;
  leaseToken: string;
  expiresAt: Date;
  createdAt: Date;
};
export type MailOutcome =
  | { status: 'DONE' }
  | { status: 'RETRY'; delayMs: number; code: string }
  | { status: 'FAILED'; code: string };

@Injectable()
export class MailOutboxRepository {
  constructor(private readonly prisma: PrismaService) {}
  // nextAttemptAt/expiresAt are written on the app clock and compared on it;
  // leaseUntil is written and compared on the database clock.
  async claim(id?: string): Promise<MailClaim | null> {
    const token = randomUUID();
    const now = new Date();
    const only = id ? Prisma.sql`AND id=${id}::uuid` : Prisma.empty;
    const rows = await this.prisma.client.$queryRaw<MailClaim[]>(Prisma.sql`
      WITH candidate AS (
        SELECT id FROM woori.mail_outbox
        WHERE ((status='PENDING' AND "nextAttemptAt"<=${now}) OR (status='RUNNING' AND "leaseUntil"<=now())) ${only}
        ORDER BY "nextAttemptAt",id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE woori.mail_outbox m SET status='RUNNING',"leaseToken"=${token}::uuid,
        "leaseUntil"=now()+interval '60 seconds',attempts=m.attempts+1
      FROM candidate c WHERE m.id=c.id
      RETURNING m.id,m.kind::text AS kind,m."userId",m."emailTokenId",m.payload,m.attempts,m."leaseToken",m."expiresAt",m."createdAt"`);
    return rows[0] ?? null;
  }
  // Revoked (consumed), expired or replaced tokens and withdrawn accounts
  // never receive a queued mail.
  async sendable(claim: MailClaim): Promise<'ok' | 'expired' | 'superseded'> {
    const now = new Date();
    if (claim.expiresAt <= now) return 'expired';
    const user = await this.prisma.client.user.findUnique({
      where: { id: claim.userId },
      select: { status: true },
    });
    if (!user || user.status === 'DELETED') return 'superseded';
    if (!TOKEN_KINDS.has(claim.kind)) return 'ok';
    if (!claim.emailTokenId) return 'superseded';
    const token = await this.prisma.client.emailToken.findUnique({
      where: { id: claim.emailTokenId },
      select: { consumedAt: true, expiresAt: true },
    });
    if (!token || token.consumedAt) return 'superseded';
    return token.expiresAt > now ? 'ok' : 'expired';
  }
  /** Lease-fenced. A finished (sent/failed) mail keeps no payload. */
  async finish(claim: MailClaim, outcome: MailOutcome) {
    const status = outcome.status === 'RETRY' ? 'PENDING' : outcome.status;
    const next =
      outcome.status === 'RETRY'
        ? new Date(Date.now() + outcome.delayMs)
        : null;
    const code = outcome.status === 'DONE' ? 'sent' : outcome.code;
    const count = await this.prisma.client.$executeRaw`
      UPDATE woori.mail_outbox SET status=${status}::woori."JobStatus",
        payload=CASE WHEN ${status}='PENDING' THEN payload ELSE NULL END,
        "resultCode"=${code},"sentAt"=CASE WHEN ${status}='DONE' THEN now() ELSE "sentAt" END,
        "nextAttemptAt"=COALESCE(${next}::timestamptz,"nextAttemptAt"),"leaseToken"=NULL,"leaseUntil"=NULL
      WHERE id=${claim.id}::uuid AND "leaseToken"=${claim.leaseToken}::uuid AND status='RUNNING' AND "leaseUntil">now()`;
    return count === 1;
  }
  /** Waiting mails past their expiry are closed and wiped without sending. */
  async expire() {
    return this.prisma.client.$executeRaw`
      UPDATE woori.mail_outbox SET status='FAILED',payload=NULL,"resultCode"='expired'
      WHERE status='PENDING' AND "expiresAt"<=${new Date()}`;
  }
  /** Finished rows hold no payload; even their metadata goes after 14 days. */
  async purge() {
    return this.prisma.client.$executeRaw`
      DELETE FROM woori.mail_outbox WHERE status IN ('DONE','FAILED')
        AND "createdAt"<${new Date(Date.now() - MAIL_RETENTION_DAYS * 86_400_000)}`;
  }
}

@Injectable()
export class MailOutboxService {
  constructor(
    private readonly repository: MailOutboxRepository,
    private readonly mail: MailService
  ) {}
  /**
   * Immediate attempt right after the enqueuing transaction committed. Never
   * throws: a failure stays queued for the worker. true when it was sent now.
   */
  async dispatch(id: string) {
    try {
      const claim = await this.repository.claim(id);
      return claim ? (await this.process(claim)).status === 'DONE' : false;
    } catch {
      return false;
    }
  }
  /** One bounded worker pass (counts only; never recipients or tokens). */
  async runBatch(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid mail batch size');
    const result = { sent: 0, retried: 0, failed: 0, expired: 0 };
    result.expired = await this.repository.expire();
    for (let index = 0; index < limit; index++) {
      const claim = await this.repository.claim();
      if (!claim) break;
      const outcome = await this.process(claim);
      if (outcome.status === 'DONE') result.sent++;
      else if (outcome.status === 'RETRY') result.retried++;
      else result.failed++;
    }
    await this.repository.purge();
    return result;
  }
  private async process(claim: MailClaim): Promise<MailOutcome> {
    const outcome = await this.attempt(claim);
    await this.repository.finish(claim, outcome);
    return outcome;
  }
  private async attempt(claim: MailClaim): Promise<MailOutcome> {
    const state = await this.repository.sendable(claim);
    if (state !== 'ok') return { status: 'FAILED', code: state };
    let payload: MailPayload;
    try {
      const key = mailOutboxKey();
      if (!key || !claim.payload) throw new Error('No payload');
      payload = decryptMailPayload(claim.payload, key, claim.id);
    } catch {
      return { status: 'FAILED', code: 'payload-unreadable' };
    }
    try {
      await this.deliver(claim, payload, {
        idempotencyKey: `woori-mail-${claim.id}`,
        fileName: `${claim.createdAt.getTime()}-${claim.id}`,
      });
      return { status: 'DONE' };
    } catch (error) {
      const permanent = error instanceof MailDeliveryError && !error.retryable;
      if (permanent) return { status: 'FAILED', code: error.reason };
      const code =
        error instanceof MailDeliveryError ? error.reason : 'delivery-error';
      if (claim.attempts >= MAIL_MAX_ATTEMPTS)
        return { status: 'FAILED', code: 'attempts-exhausted' };
      return {
        status: 'RETRY',
        delayMs: mailRetryDelayMs(claim.attempts),
        code,
      };
    }
  }
  private deliver(
    claim: MailClaim,
    payload: MailPayload,
    options: MailDeliveryOptions
  ) {
    const token = () => {
      if (!payload.token) throw new MailDeliveryError(false, 'payload-invalid');
      return payload.token;
    };
    switch (claim.kind) {
      case 'VERIFY_EMAIL':
        return this.mail.sendVerification(payload.to, token(), options);
      case 'RESET_PASSWORD':
        return this.mail.sendPasswordReset(payload.to, token(), options);
      case 'CHANGE_EMAIL':
        return this.mail.sendEmailChange(payload.to, token(), options);
      case 'RECOVER_USERNAME':
        if (!payload.username)
          throw new MailDeliveryError(false, 'payload-invalid');
        return this.mail.sendUsername(payload.to, payload.username, options);
      case 'EMAIL_CHANGED_NOTICE':
        return this.mail.sendEmailChangedNotice(payload.to, options);
    }
  }
}
