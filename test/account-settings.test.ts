import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { AccountSettingsService } from '../src/domain/auth/account-settings.service';
import { AccountSettingsRepository } from '../src/domain/auth/account-settings.repository';
import { AuthRateLimitService } from '../src/domain/auth/auth-rate-limit.service';
import { MailService } from '../src/domain/auth/mail.service';
import { createToken } from '../src/domain/auth/auth-token';
import { hashPassword } from '../src/domain/auth/password';

test('account settings: ambiguous email delivery preserves issued token and prior address', async () => {
  let issued = false;
  const repository = {
    findUser: async () => ({
      passwordHash: await hashPassword('settings-original-password-2026'),
    }),
    requestEmail: async () => {
      issued = true;
    },
  } as unknown as AccountSettingsRepository;
  const mail = {
    sendEmailChange: async () => {
      throw new Error('provider timeout');
    },
  } as unknown as MailService;
  const limits = { consume: async () => {} } as unknown as AuthRateLimitService;
  const service = new AccountSettingsService(repository, limits, mail);
  const request = {
    headers: { cookie: `woori_session=${createToken()}` },
  } as Request;
  await assert.rejects(
    service.requestEmail(
      'fixture-user',
      {
        currentPassword: 'settings-original-password-2026',
        newEmail: 'new@example.test',
      },
      request
    ),
    (error: any) => error.getResponse().code === 'MAIL_DELIVERY_UNAVAILABLE'
  );
  assert.equal(issued, true);
});

test('account settings: previous-address notice failure cannot reverse successful confirmation', async () => {
  let committed = false,
    cleared = false;
  const repository = {
    confirmEmail: async () => {
      committed = true;
      return { previousEmail: 'old@example.test' };
    },
  } as unknown as AccountSettingsRepository;
  const mail = {
    sendEmailChangedNotice: async () => {
      assert.equal(committed, true);
      throw new Error('provider timeout');
    },
  } as unknown as MailService;
  const limits = { consume: async () => {} } as unknown as AuthRateLimitService;
  const service = new AccountSettingsService(repository, limits, mail);
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
});
