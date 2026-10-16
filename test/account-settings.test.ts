import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { AccountSettingsService } from '../src/domain/auth/account-settings.service';
import { AccountSettingsRepository } from '../src/domain/auth/account-settings.repository';
import { AuthRateLimitService } from '../src/domain/auth/auth-rate-limit.service';
import type { TokenMail } from '../src/domain/auth/auth.repository';
import { createToken, hashToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';
import type { MailOutboxService } from '../src/domain/mail/mail-outbox';

// W07-4: mails are queued with their token in one transaction (mail outbox).
// A configured mail setup is needed to issue a token at all.
function withMailConfigured(t: { after: (fn: () => void) => void }) {
  const keys = [
    'MAIL_MODE',
    'RESEND_API_KEY',
    'MAIL_FROM',
    'WEB_ORIGIN',
    'MAIL_OUTBOX_KEY',
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  process.env.MAIL_MODE = 'resend';
  process.env.RESEND_API_KEY = 'unit-test-only';
  process.env.MAIL_FROM = '우리 <no-reply@mail.woori.test>';
  process.env.WEB_ORIGIN = 'https://woori.test';
  process.env.MAIL_OUTBOX_KEY = Buffer.alloc(32, 3).toString('base64');
}

test('account settings: ambiguous email delivery preserves issued token and prior address', async (t) => {
  withMailConfigured(t);
  let issued: { tokenHash: string; mail: TokenMail } | undefined;
  const repository = {
    findUser: async () => ({
      passwordHash: await hashPassword('settings-original-password-2026'),
    }),
    requestEmail: async (
      _userId: string,
      _session: string,
      _hash: string,
      _email: string,
      tokenHash: string,
      mail: TokenMail
    ) => {
      issued = { tokenHash, mail };
    },
  } as unknown as AccountSettingsRepository;
  const dispatched: string[] = [];
  const outbox = {
    dispatch: async (id: string) => {
      dispatched.push(id);
      throw new Error('provider timeout');
    },
  } as unknown as MailOutboxService;
  const limits = { consume: async () => {} } as unknown as AuthRateLimitService;
  const service = new AccountSettingsService(repository, limits, outbox);
  const request = {
    headers: { cookie: `woori_session=${createToken()}` },
  } as Request;
  const dto = {
    currentPassword: 'settings-original-password-2026',
    newEmail: 'new@example.test',
  };
  // The mail is queued with the token: a provider failure after the commit is
  // retried by the worker and the issued token stays valid.
  assert.deepEqual(await service.requestEmail('fixture-user', dto, request), {
    accepted: true,
  });
  assert.ok(issued);
  assert.equal(issued.tokenHash, hashToken(issued.mail.token));
  assert.deepEqual(dispatched, [issued.mail.id]);
  // Without a deliverable mail setup no token is issued at all.
  issued = undefined;
  delete process.env.MAIL_OUTBOX_KEY;
  await assert.rejects(
    service.requestEmail('fixture-user', dto, request),
    (error: any) => error.getResponse().code === 'MAIL_DELIVERY_UNAVAILABLE'
  );
  assert.equal(issued, undefined);
});

test('account settings: previous-address notice failure cannot reverse successful confirmation', async (t) => {
  withMailConfigured(t);
  let committed = false,
    cleared = false,
    noticeId: string | undefined;
  const repository = {
    confirmEmail: async (
      _userId: string,
      _session: string,
      _token: string,
      notice?: string
    ) => {
      committed = true;
      noticeId = notice;
      return { previousEmail: 'old@example.test', noticeQueued: true };
    },
  } as unknown as AccountSettingsRepository;
  const outbox = {
    dispatch: async (id: string) => {
      assert.equal(committed, true);
      assert.equal(id, noticeId);
      throw new Error('provider timeout');
    },
  } as unknown as MailOutboxService;
  const limits = { consume: async () => {} } as unknown as AuthRateLimitService;
  const service = new AccountSettingsService(repository, limits, outbox);
  const request = {
    headers: { cookie: `woori_session=${createToken()}` },
  } as Request;
  const response = {
    clearCookie: () => {
      cleared = true;
    },
  } as unknown as Response;
  await service.confirmEmail('fixture-user', createToken(), request, response);
  assert.equal(cleared, true);
  assert.ok(noticeId);
});
