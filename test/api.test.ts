import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { runtimeConfig } from '../src/common/configurations/runtime.config';

test('health contract, private routes, fabricated credentials and CORS', async () => {
  // No DB or cloud credentials are needed and no domain query is reachable.
  const old = process.env.CORS_ALLOWED_ORIGINS;
  const oldAdmin = [
    process.env.ADMIN_WEB_ORIGIN,
    process.env.ADMIN_TOTP_ENCRYPTION_KEY,
  ];
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.test';
  delete process.env.ADMIN_WEB_ORIGIN;
  delete process.env.ADMIN_TOTP_ENCRYPTION_KEY;
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const oldRelease = process.env.WOORI_RELEASE;
    delete process.env.WOORI_RELEASE;
    const health = await api.get('/healthz').expect(200);
    assert.deepEqual(health.body, {
      service: 'woori-api',
      status: 'alive',
      implementation: 'auth-groups-media',
      featuresReady: false,
      release: null,
    });
    assert.equal(health.headers['cache-control'], 'no-store');
    // Only a full lowercase git SHA is echoed; other text reads as unknown.
    const sha = 'a'.repeat(40);
    for (const [value, expected] of [
      [sha, sha],
      ['A'.repeat(40), null],
      ['abc1234', null],
      [`${sha}\n<script>`, null],
    ] as const) {
      process.env.WOORI_RELEASE = value;
      const tagged = await api.get('/healthz').expect(200);
      assert.equal(tagged.body.release, expected);
    }
    if (oldRelease === undefined) delete process.env.WOORI_RELEASE;
    else process.env.WOORI_RELEASE = oldRelease;
    const ready = await api.get('/readyz').expect(503);
    assert.deepEqual(ready.body, {
      status: 'not_ready',
      code: 'DEPENDENCIES_NOT_READY',
    });
    for (const path of [
      '/v1/groups',
      '/v1/groups/not-a-uuid/albums',
      '/v1/photos/p/comments',
      '/v1/comments',
      '/v1/notifications',
      '/v1/notices',
      '/v1/notices/315097d9-f1a4-4202-ad40-455124a80cc2',
      '/v1/inquiries',
      '/v1/inquiries/315097d9-f1a4-4202-ad40-455124a80cc2',
      '/v1/reports',
      '/v1/blocks',
    ]) {
      await api.get(path).expect(401);
      const res = await api
        .get(path)
        .set('Authorization', 'Bearer unsigned.fake.token')
        .set('Cookie', 'session=mock')
        .set('X-User-Id', 'owner')
        .expect(401);
      assert.equal(res.body.code, 'AUTHENTICATION_REQUIRED');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    // Without ADMIN_WEB_ORIGIN and ADMIN_TOTP_ENCRYPTION_KEY the admin realm is
    // closed before any credential is examined; fabricated credentials of either
    // realm never authorize it (no DB is configured, so nothing is looked up).
    for (const path of ['/v1/admin', '/v1/admin/users', '/v1/admin/auth/me']) {
      const res = await api
        .get(path)
        .set('Authorization', 'Bearer unsigned.fake.token')
        .set('Cookie', `session=mock; woori_session=${'a'.repeat(43)}`)
        .set('X-User-Id', 'owner')
        .expect(503);
      assert.equal(res.body.code, 'ADMIN_NOT_CONFIGURED');
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    await api
      .head('/v1/photos/p/comments')
      .set('Range', 'bytes=0-10')
      .expect(401);
    await api.post('/v1/uploads').send({ groupId: 'g' }).expect(403);
    await api
      .post('/v1/uploads')
      .set('Origin', 'https://app.example.test')
      .set('X-Woori-Request', '1')
      .send({ groupId: 'g' })
      .expect(401);
    const blocked = await api
      .get('/healthz')
      .set('Origin', 'https://evil.example')
      .expect(200);
    assert.equal(blocked.headers['access-control-allow-origin'], undefined);
    const allowed = await api
      .get('/healthz')
      .set('Origin', 'https://app.example.test')
      .expect(200);
    assert.equal(
      allowed.headers['access-control-allow-origin'],
      'https://app.example.test'
    );
  } finally {
    await app.close();
    if (old === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = old;
    if (oldAdmin[0] !== undefined) process.env.ADMIN_WEB_ORIGIN = oldAdmin[0];
    if (oldAdmin[1] !== undefined)
      process.env.ADMIN_TOTP_ENCRYPTION_KEY = oldAdmin[1];
  }
});
test('CORS configuration rejects wildcard or URL paths', () => {
  assert.deepEqual(runtimeConfig({}).allowedOrigins, []);
  assert.throws(() => runtimeConfig({ CORS_ALLOWED_ORIGINS: '*' }));
  assert.throws(() =>
    runtimeConfig({ CORS_ALLOWED_ORIGINS: 'https://example.test/path' })
  );
});
