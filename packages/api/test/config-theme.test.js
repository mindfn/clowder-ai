import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { configThemeRoutes } = await import('../dist/routes/config-theme.js');
const { readUserPreferences } = await import('../dist/config/user-preferences-store.js');

describe('F770 theme config in user-preferences.json', () => {
  let tempRoot;
  let app;
  const savedEnv = {};

  beforeEach(async () => {
    tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-theme-'));
    for (const key of ['THEME_CONFIG', 'DEFAULT_OWNER_USER_ID']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    app = Fastify({ logger: false });
    await app.register(configThemeRoutes, { projectRoot: tempRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
    for (const key of ['THEME_CONFIG', 'DEFAULT_OWNER_USER_ID']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('a write is visible to a re-read in the same process — no restart required', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { themeConfig: '{"activeId":"dark"}' },
    });
    assert.equal(put.statusCode, 200);

    // Same process, no restart, no cache flush: the next read must see the write.
    const got = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(got.statusCode, 200);
    const body = got.json();
    assert.equal(body.themeConfig, '{"activeId":"dark"}');
    assert.equal(body.source, 'preferences');
    assert.equal(body.migratedFromEnv, false);

    const second = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { themeConfig: '{"activeId":"light"}' },
    });
    assert.equal(second.statusCode, 200);
    const reread = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(reread.json().themeConfig, '{"activeId":"light"}');
  });

  it('migrates a legacy env value into the JSON store on first read and keeps it', async () => {
    process.env.THEME_CONFIG = '{"activeId":"legacy-custom"}';

    const first = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(first.statusCode, 200);
    const firstBody = first.json();
    assert.equal(firstBody.themeConfig, '{"activeId":"legacy-custom"}');
    assert.equal(firstBody.source, 'env-fallback');
    assert.equal(firstBody.migratedFromEnv, true);

    // The value landed in the JSON store — durable, not just served from env.
    assert.equal(readUserPreferences(tempRoot).themeConfig, '{"activeId":"legacy-custom"}');

    // Second read: JSON wins over the still-present env value.
    const second = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(second.json().source, 'preferences');
    assert.equal(second.json().themeConfig, '{"activeId":"legacy-custom"}');
  });

  it('prefers the JSON store over the env fallback', async () => {
    process.env.THEME_CONFIG = '{"activeId":"legacy"}';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { themeConfig: '{"activeId":"new"}' },
    });
    assert.equal(put.statusCode, 200);

    const got = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(got.json().themeConfig, '{"activeId":"new"}');
    assert.equal(got.json().source, 'preferences');
  });

  it('returns none when neither JSON nor env has a value', async () => {
    const got = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(got.statusCode, 200);
    assert.deepEqual(got.json(), { themeConfig: null, source: 'none', migratedFromEnv: false });
  });

  it('rejects writes without identity and writes from a non-owner', async () => {
    const noIdentity = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      payload: { themeConfig: '{"activeId":"dark"}' },
    });
    assert.equal(noIdentity.statusCode, 400);

    process.env.DEFAULT_OWNER_USER_ID = 'owner-real';
    const wrongUser = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'intruder' },
      payload: { themeConfig: '{"activeId":"dark"}' },
    });
    assert.equal(wrongUser.statusCode, 403);
    const none = await app.inject({ method: 'GET', url: '/api/config/theme' });
    assert.equal(none.json().source, 'none');
  });

  it('rejects invalid payloads', async () => {
    const empty = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { themeConfig: '' },
    });
    assert.equal(empty.statusCode, 400);

    const wrongShape = await app.inject({
      method: 'PUT',
      url: '/api/config/theme',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { theme: 'x' },
    });
    assert.equal(wrongShape.statusCode, 400);
  });
});
