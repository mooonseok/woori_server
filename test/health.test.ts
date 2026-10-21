import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthController } from '../src/domain/health/health.controller';
import { API_CONTRACT_VERSION } from '../src/common/configurations/release';

// readyz reports whether the push keys are loaded (not whether a delivery
// works); a DB or mail failure still answers 503 without details.
test('readiness reports loaded push keys and keeps failures generic', async () => {
  const names = [
    'MAIL_MODE',
    'RESEND_API_KEY',
    'MAIL_FROM',
    'WEB_ORIGIN',
    'MAIL_OUTBOX_KEY',
    'WEB_PUSH_VAPID_PUBLIC_KEY',
    'WEB_PUSH_VAPID_PRIVATE_KEY',
    'WEB_PUSH_VAPID_SUBJECT',
    'PUSH_ENCRYPTION_KEY',
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  let dbUp = true;
  const prisma = {
    client: {
      user: {
        findFirst: async () => {
          if (!dbUp) throw new Error('db down');
          return null;
        },
      },
    },
  };
  const media = { enabled: () => true };
  const health = new HealthController(prisma as never, media as never);
  try {
    Object.assign(process.env, {
      MAIL_MODE: 'resend',
      RESEND_API_KEY: 'test-only',
      MAIL_FROM: '우리 <no-reply@mail.woori.stream>',
      WEB_ORIGIN: 'https://woori.stream',
      MAIL_OUTBOX_KEY: randomBytes(32).toString('base64'),
    });
    for (const n of names.slice(5)) delete process.env[n];
    assert.deepEqual((await health.readiness()).capabilities, {
      authentication: true,
      groups: true,
      invitations: true,
      media: true,
      push: false,
    });

    const pair = createECDH('prime256v1');
    pair.generateKeys();
    Object.assign(process.env, {
      WEB_PUSH_VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
      WEB_PUSH_VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'),
      WEB_PUSH_VAPID_SUBJECT: 'mailto:ops@woori.example',
      PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    assert.equal((await health.readiness()).capabilities.push, true);
    // A partial set fails startup elsewhere; readiness never claims it.
    delete process.env.PUSH_ENCRYPTION_KEY;
    assert.equal((await health.readiness()).capabilities.push, false);

    dbUp = false;
    await assert.rejects(
      health.readiness(),
      (
        error: Error & {
          getResponse(): unknown;
        }
      ) => {
        assert.deepEqual(error.getResponse(), {
          status: 'not_ready',
          code: 'DEPENDENCIES_NOT_READY',
        });
        return true;
      }
    );
  } finally {
    for (const [n, v] of Object.entries(saved))
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
  }
});

// Client deployments compare /healthz contract with their minimum version, so
// the compiled value must be exactly the OpenAPI document's info.version (a
// plain x.y.z string) and the Liveness schema must require it.
test('liveness reports the OpenAPI contract version it was built with', () => {
  // Compiled tests run from dist/test; the document stays at the repo root.
  const openapi = JSON.parse(
    readFileSync(join(__dirname, '../../contracts/openapi.json'), 'utf8')
  );
  assert.equal(API_CONTRACT_VERSION, openapi.info.version);
  assert.match(API_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  const liveness = openapi.components.schemas.Liveness;
  assert.ok(liveness.required.includes('contract'));
  assert.equal(liveness.properties.contract.type, 'string');
  assert.ok(
    new RegExp(liveness.properties.contract.pattern).test(API_CONTRACT_VERSION)
  );
  const health = new HealthController({} as never, {} as never);
  const body = health.liveness();
  assert.equal(body.contract, openapi.info.version);
  assert.deepEqual(Object.keys(body).sort(), [...liveness.required].sort());
});
