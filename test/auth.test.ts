import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { SignupDto } from '../src/domain/auth/dto/auth.dto';
import { hashPassword, verifyPassword } from '../src/domain/auth/password';
import { createToken, hashToken, sessionToken } from '../src/domain/auth/auth-token';
import { AuthRateLimitService, rateLimitKey } from '../src/domain/auth/auth-rate-limit.service';
import type { PrismaService } from '../src/common/modules/prisma/prisma.service';
import { MailService } from '../src/domain/auth/mail.service';

test('passwords use unique salts and reject incorrect or malformed credentials', async () => {
  const first = await hashPassword('good-password-2026');
  const second = await hashPassword('good-password-2026');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('good-password-2026', first), true);
  assert.equal(await verifyPassword('wrong-password-2026', first), false);
  assert.equal(await verifyPassword('good-password-2026'), false);
  assert.equal(await verifyPassword('good-password-2026', 'plaintext'), false);
});
test('signup validates and normalizes account fields without changing the password', async () => {
  const dto = plainToInstance(SignupDto, { username: '  FAMILY_1 ', email: ' Me@Example.COM ', displayName: ' 가족 ', password: ' passphrase long ' });
  assert.equal((await validate(dto)).length, 0);
  assert.equal(dto.username, 'family_1');
  assert.equal(dto.email, 'me@example.com');
  assert.equal(dto.password, ' passphrase long ');
  for (const username of ['aa', 'a.b', 'x'.repeat(33)]) assert.ok((await validate(plainToInstance(SignupDto, { ...dto, username }))).length > 0);
  for (const password of ['short', 'x'.repeat(129)]) assert.ok((await validate(plainToInstance(SignupDto, { ...dto, password }))).length > 0);
});
test('opaque session parser rejects duplicate and malformed cookies', () => {
  const token = createToken();
  const name = process.env.NODE_ENV === 'production' ? '__Host-woori_session' : 'woori_session';
  const request = (cookie: string) => ({ headers: { cookie } }) as Request;
  assert.equal(sessionToken(request(`${name}=${token}`)), token);
  assert.equal(sessionToken(request(`${name}=${token}; ${name}=${token}`)), undefined);
  assert.equal(sessionToken(request(`${name}=unsigned.token`)), undefined);
  assert.equal(sessionToken(request(`session=${token}`)), undefined);
  assert.equal(hashToken(token).length, 64);
  assert.notEqual(hashToken(token), token);
});
test('rate limit keys hide identities and separate time windows', () => {
  const date = new Date('2026-10-13T01:00:00Z');
  const first = rateLimitKey('login', 'family@example.com', date, 60000);
  const same = rateLimitKey('login', 'family@example.com', new Date(date.getTime() + 59000), 60000);
  const next = rateLimitKey('login', 'family@example.com', new Date(date.getTime() + 60000), 60000);
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, next.id);
  assert.doesNotMatch(first.id, /family|example/);
});
test('rate limit rejects the request after the allowed attempts', async () => {
  let count = 0;
  const prisma = { client: { $queryRaw: async () => [{ attempts: ++count }] } } as unknown as PrismaService;
  const service = new AuthRateLimitService(prisma);
  await service.consume('login:test', 2);
  await service.consume('login:test', 2);
  await assert.rejects(service.consume('login:test', 2), (error: any) => error.getStatus() === 429);
});
test('file mail cannot be enabled in production', async () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, WEB_ORIGIN: process.env.WEB_ORIGIN, MAIL_MODE: process.env.MAIL_MODE };
  process.env.NODE_ENV = 'production'; process.env.WEB_ORIGIN = 'https://app.example.test'; process.env.MAIL_MODE = 'file';
  try { await assert.rejects(new MailService().sendVerification('nobody@example.test', createToken())); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
