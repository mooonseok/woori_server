import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  decryptSubscription,
  encryptSubscription,
  validateEndpoint,
  validateSubscription,
} from '../src/common/push/push-subscription';
import { webPushConfig } from '../src/common/push/web-push.config';

function fixture() {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/security-test',
    keys: {
      p256dh: pair.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

test('Web Push secrets use authenticated randomized encryption and reject tampering', () => {
  const original = fixture();
  const key = randomBytes(32).toString('base64');
  const encrypted = encryptSubscription(original, key);
  assert.notEqual(encrypted, encryptSubscription(original, key));
  assert.deepEqual(decryptSubscription(encrypted, key), original);
  for (const secret of [
    original.endpoint,
    original.keys.auth,
    original.keys.p256dh,
  ])
    assert.equal(encrypted.includes(secret), false);
  assert.throws(() =>
    decryptSubscription(encrypted, randomBytes(32).toString('base64'))
  );
  const parts = encrypted.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  assert.throws(() => decryptSubscription(parts.join('.'), key));
});

test('Web Push accepts only canonical HTTPS provider endpoints and valid P-256 subscription keys', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/token',
  ])
    assert.doesNotThrow(() => validateEndpoint(endpoint));
  for (const endpoint of [
    'https://localhost/push',
    'https://[::1]/push',
    'https://fcm.googleapis.com.evil.test/push',
    'https://fcm.googleapis.com@evil.test/push',
    'https://evil.test@fcm.googleapis.com/push',
    'https://fcm.googleapis.com:444/push',
    'http://fcm.googleapis.com/push',
    'https://fcm.googleapis.com/push#token',
    'https://fcm.googleapis.com\\@evil.test/push',
  ])
    assert.throws(() => validateEndpoint(endpoint));
  const valid = fixture();
  assert.doesNotThrow(() => validateSubscription(valid));
  assert.throws(() =>
    validateSubscription({
      ...valid,
      keys: { ...valid.keys, auth: randomBytes(17).toString('base64url') },
    })
  );
  // Correct length/prefix alone is insufficient: reject a point off the curve.
  assert.throws(() =>
    validateSubscription({
      ...valid,
      keys: {
        ...valid.keys,
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString(
          'base64url'
        ),
      },
    })
  );
});

test('Web Push config permits fully disabled mode but rejects partial or mismatched secrets', () => {
  assert.equal(webPushConfig({}), null);
  assert.throws(() => webPushConfig({ WEB_PUSH_VAPID_PUBLIC_KEY: 'partial' }));
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  const env = {
    WEB_PUSH_VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
    WEB_PUSH_VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'),
    WEB_PUSH_VAPID_SUBJECT: 'mailto:push@example.test',
    PUSH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  assert.ok(webPushConfig(env));
  assert.throws(() =>
    webPushConfig({ ...env, WEB_PUSH_VAPID_PUBLIC_KEY: fixture().keys.p256dh })
  );
  assert.throws(() =>
    webPushConfig({
      ...env,
      PUSH_ENCRYPTION_KEY: randomBytes(16).toString('base64'),
    })
  );
});
