import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startupFailure } from '../src/common/configurations/startup-diagnostics';
import { runtimeConfig } from '../src/common/configurations/runtime.config';

test('startup errors explain occupied ports and permissions without echoing exception secrets', () => {
  const error = Object.assign(
    new Error('postgresql://private:secret@db.invalid'),
    { code: 'EADDRINUSE' }
  );
  assert.match(startupFailure(error, 3001), /EADDRINUSE.*3001/);
  assert.doesNotMatch(startupFailure(error, 3001), /private|secret|db.invalid/);
  assert.match(startupFailure({ code: 'EACCES' }, 3001), /권한/);
});
test('actual invalid runtime settings receive actionable safe messages', () => {
  for (const env of [
    { PORT: 'invalid-secret' },
    { TRUST_PROXY_HOPS: 'invalid-secret' },
    { CORS_ALLOWED_ORIGINS: 'https://host.invalid/private-secret' },
  ]) {
    try {
      runtimeConfig(env);
      assert.fail('configuration should reject');
    } catch (error) {
      assert.match(startupFailure(error), /\[CONFIG\]/);
      assert.doesNotMatch(
        startupFailure(error),
        /invalid-secret|private-secret/
      );
    }
  }
});
test('unknown errors and hostile codes never leak raw messages or stacks', () => {
  const error = Object.assign(new TypeError('raw-secret'), {
    code: 'token-secret',
  });
  assert.match(startupFailure(error), /TypeError/);
  assert.doesNotMatch(
    startupFailure(error),
    /raw-secret|token-secret|startup.test/
  );
  assert.match(startupFailure(null), /UNKNOWN/);
});
