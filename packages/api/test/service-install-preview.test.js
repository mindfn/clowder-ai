// @ts-check
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';

const tmpDir = mkdtempSync(join(tmpdir(), 'svc-preview-'));
process.env.CAT_CAFE_SERVICES_CONFIG = join(tmpDir, 'services.json');

const { servicesRoutes } = await import('../dist/routes/services.js');

describe('service install-preview route', () => {
  let app;

  before(async () => {
    app = Fastify();
    await app.register(servicesRoutes);
    await app.ready();
  });

  after(async () => {
    delete process.env.CAT_CAFE_SERVICES_CONFIG;
    delete process.env.DEFAULT_OWNER_USER_ID;
    rmSync(tmpDir, { recursive: true, force: true });
    await app?.close();
  });

  test('GET /api/services/:id/install-preview returns recommendation envelope', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const res = await app.inject({
      method: 'GET',
      url: '/api/services/embedding-model/install-preview',
      headers: { 'x-cat-cafe-user': 'someone' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.profile, 'has profile');
    assert.ok(body.recommendation, 'has recommendation');
    assert.equal(body.recommendation.serviceId, 'embedding-model');
    assert.ok(body.profile.os);
    assert.ok(body.profile.arch);
  });

  test('GET install-preview for unknown service → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/services/no-such-service/install-preview',
      headers: { 'x-cat-cafe-user': 'someone' },
    });
    assert.equal(res.statusCode, 404);
  });

  test('GET install-preview without auth → 401', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
    const res = await app.inject({
      method: 'GET',
      url: '/api/services/embedding-model/install-preview',
    });
    assert.equal(res.statusCode, 401);
    delete process.env.DEFAULT_OWNER_USER_ID;
  });

  test('install-preview profile matches current platform', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/services/whisper-stt/install-preview',
      headers: { 'x-cat-cafe-user': 'someone' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.profile.os, process.platform);
  });
});
