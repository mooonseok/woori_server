import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { runtimeConfig } from '../src/common/configurations/runtime.config';

test('health contract, private routes, fabricated credentials and CORS', async () => {
  // No DB or cloud credentials are needed and no domain query is reachable.
  const old = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.test';
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const api = request(app.getHttpServer());
    const health = await api.get('/healthz').expect(200);
    assert.deepEqual(health.body, {
      service: 'woori-api',
      status: 'alive',
      implementation: 'auth-groups-media',
      featuresReady: false,
    });
    assert.equal(health.headers['cache-control'], 'no-store');
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
      '/v1/admin',
      '/v1/admin/users',
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
  }
});
test('CORS configuration rejects wildcard or URL paths', () => {
  assert.deepEqual(runtimeConfig({}).allowedOrigins, []);
  assert.throws(() => runtimeConfig({ CORS_ALLOWED_ORIGINS: '*' }));
  assert.throws(() =>
    runtimeConfig({ CORS_ALLOWED_ORIGINS: 'https://example.test/path' })
  );
});
