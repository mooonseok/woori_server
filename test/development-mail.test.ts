import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os = require('node:os');
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { developmentMailDirectory } from '../src/common/configurations/development-mail';
import { MailService } from '../src/domain/auth/mail.service';
import { HealthController } from '../src/domain/health/health.controller';
import type { PrismaService } from '../src/common/modules/prisma/prisma.service';
import type { MediaStorageService } from '../src/common/media/media-storage.service';

test('portable development mail uses the current home and preserves private file storage', async (t) => {
  const home = await mkdtemp(join(os.tmpdir(), 'woori-mail-home-'));
  const saved = {
    DEV_MAIL_DIR: process.env.DEV_MAIL_DIR,
    MAIL_MODE: process.env.MAIL_MODE,
    NODE_ENV: process.env.NODE_ENV,
    WEB_ORIGIN: process.env.WEB_ORIGIN,
  };
  t.after(async () => {
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  t.mock.method(os, 'homedir', () => home);
  process.env.NODE_ENV = 'development';
  process.env.MAIL_MODE = 'file';
  process.env.WEB_ORIGIN = 'http://localhost:3210';
  delete process.env.DEV_MAIL_DIR;
  const directory = join(home, '.woori', 'dev-mail');
  assert.equal(developmentMailDirectory(), directory);
  process.env.DEV_MAIL_DIR = '';
  assert.equal(developmentMailDirectory(), directory);

  await new MailService().sendVerification(
    'test@example.test',
    'fixture-token'
  );
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const file = join(directory, files[0]);
  const message = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(message.to, 'test@example.test');
  assert.match(
    message.text,
    /http:\/\/localhost:3210\/verify-email\?token=fixture-token/
  );
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const health = new HealthController(
    {
      client: { user: { findFirst: async () => null } },
    } as unknown as PrismaService,
    { enabled: () => false } as MediaStorageService
  );
  assert.equal((await health.readiness()).status, 'ready');
  process.env.DEV_MAIL_DIR = join(home, 'custom-outbox');
  assert.equal(developmentMailDirectory(), process.env.DEV_MAIL_DIR);

  for (const invalid of [
    'relative/mail',
    process.cwd(),
    join(process.cwd(), '..mail'),
  ]) {
    process.env.DEV_MAIL_DIR = invalid;
    assert.equal(developmentMailDirectory(), undefined);
    await assert.rejects(health.readiness());
    await assert.rejects(
      new MailService().sendVerification('test@example.test', 'fixture-token')
    );
  }
  process.env.DEV_MAIL_DIR = '';
  process.env.NODE_ENV = 'production';
  assert.equal(developmentMailDirectory(), undefined);
  await assert.rejects(health.readiness());
  await assert.rejects(
    new MailService().sendVerification('test@example.test', 'fixture-token')
  );
});
