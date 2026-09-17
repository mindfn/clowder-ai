import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { configRetentionRoutes } = await import('../dist/routes/config-retention.js');
const { readUserPreferences } = await import('../dist/config/user-preferences-store.js');
const { getRetentionTtlSeconds, resetRetentionTtlForTests } = await import('../dist/config/retention-ttl-provider.js');

const ENV_KEYS = [
  'MESSAGE_TTL_SECONDS',
  'THREAD_TTL_SECONDS',
  'TASK_TTL_SECONDS',
  'SUMMARY_TTL_SECONDS',
  'BACKLOG_TTL_SECONDS',
  'DRAFT_TTL_SECONDS',
  'DEFAULT_OWNER_USER_ID',
];

const PREFS_FILE = (root) => resolve(root, '.cat-cafe', 'user-preferences.json');

describe('F770 retention presets in user-preferences.json', () => {
  let tempRoot;
  let app;
  const savedEnv = {};

  beforeEach(async () => {
    tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-retention-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetRetentionTtlForTests();
    app = Fastify({ logger: false });
    await app.register(configRetentionRoutes, { projectRoot: tempRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
    resetRetentionTtlForTests();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('a PUT is visible to reads and store-side TTL in the same process — no restart, zero IO', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { message: 2592000, thread: 7776000, task: 2592000, summary: 0, backlog: 0 },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().sources.message, 'preferences');

    // Same process, no restart, no cache flush: the next read must see the write.
    const got = await app.inject({ method: 'GET', url: '/api/config/retention' });
    assert.equal(got.statusCode, 200);
    const body = got.json();
    assert.equal(body.config.message, 2592000);
    assert.equal(body.config.thread, 7776000);
    assert.equal(body.config.summary, 0);
    assert.equal(body.sources.message, 'preferences');

    // Store-side reads hit the pushed in-memory value, not the file.
    assert.equal(getRetentionTtlSeconds('message'), 2592000);
    assert.equal(getRetentionTtlSeconds('summary'), null); // 0 = persistent

    // Change again: no restart in between.
    const second = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { message: 604800 },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(getRetentionTtlSeconds('message'), 604800);
    const reread = await app.inject({ method: 'GET', url: '/api/config/retention' });
    assert.equal(reread.json().config.message, 604800);
    assert.equal(reread.json().config.thread, 7776000); // untouched category kept
  });

  it('does NOT migrate a legacy env value into the JSON store — env is read-only fallback', async () => {
    process.env.MESSAGE_TTL_SECONDS = '3600';

    const got = await app.inject({ method: 'GET', url: '/api/config/retention' });
    assert.equal(got.statusCode, 200);
    const body = got.json();
    assert.equal(body.config.message, 3600);
    assert.equal(body.sources.message, 'env-fallback');
    assert.equal(body.config.thread, 0);
    assert.equal(body.sources.thread, 'default');

    // The deviation from theme/log-level, asserted: no JSON file was created.
    assert.equal(existsSync(PREFS_FILE(tempRoot)), false);
    assert.deepEqual(readUserPreferences(tempRoot), {});

    // Store-side reads see the env fallback (zero IO).
    assert.equal(getRetentionTtlSeconds('message'), 3600);
  });

  it('a user preset takes over from the env fallback, and 0 means keep forever', async () => {
    process.env.MESSAGE_TTL_SECONDS = '3600';
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { message: 0 },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().config.message, 0);
    assert.equal(put.json().sources.message, 'preferences');

    // Stored 0 (keep forever) must override the still-present env value.
    assert.equal(getRetentionTtlSeconds('message'), null);
    const got = await app.inject({ method: 'GET', url: '/api/config/retention' });
    assert.equal(got.json().config.message, 0);
    assert.equal(got.json().sources.message, 'preferences');
  });

  it('drafts are a functional constant, not a retention preset', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { message: 100, draft: 60 },
    });
    assert.equal(put.statusCode, 200);
    // Draft TTL is stated as a fact for the small-print, never writable here.
    assert.equal(put.json().draftTtlSeconds, 300);
    const got = await app.inject({ method: 'GET', url: '/api/config/retention' });
    assert.equal(got.json().draftTtlSeconds, 300);
    assert.equal('draft' in got.json().config, false);
    // The stray draft key did not land in the JSON store.
    const stored = readUserPreferences(tempRoot).retentionConfig ?? {};
    assert.equal('draft' in stored, false);
  });

  it('rejects writes without identity and writes from a non-owner', async () => {
    const noIdentity = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      payload: { message: 100 },
    });
    assert.equal(noIdentity.statusCode, 400);

    process.env.DEFAULT_OWNER_USER_ID = 'owner-real';
    const wrongUser = await app.inject({
      method: 'PUT',
      url: '/api/config/retention',
      headers: { 'x-cat-cafe-user': 'intruder' },
      payload: { message: 100 },
    });
    assert.equal(wrongUser.statusCode, 403);
    assert.equal(existsSync(PREFS_FILE(tempRoot)), false);
  });

  it('rejects invalid payloads', async () => {
    for (const bad of [-1, 1.5, '30', 2147483648, Number.NaN]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/config/retention',
        headers: { 'x-cat-cafe-user': 'owner' },
        payload: { message: bad },
      });
      assert.equal(res.statusCode, 400, `expected 400 for ${String(bad)}`);
    }
  });
});
