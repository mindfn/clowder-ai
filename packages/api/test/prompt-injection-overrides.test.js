// F257 approval executor route tests — auth gates, gate-error mapping, happy paths.
// Route-level unit tests: fake store + injected session (bootstrap integration for
// the store itself lives in hook-override-store.test.js).
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';

import { OverrideGateError } from '../dist/domains/prompt-hooks/HookOverrideStore.js';
import { promptInjectionOverrideRoutes } from '../dist/routes/prompt-injection-overrides.js';

const OWNER = 'test-owner';

function createFakeStore() {
  const calls = [];
  const overrides = new Map();
  return {
    calls,
    overrides,
    async enable(hookId, actorId, opts) {
      calls.push({ method: 'enable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: true, enabledSource: opts?.source });
    },
    async disable(hookId, actorId, opts) {
      if (hookId === 's1-immutable') {
        throw new OverrideGateError(hookId, 'disable', 'disableable', false);
      }
      if (hookId === 'no-such-hook') {
        throw new OverrideGateError(hookId, 'disable', 'unknown-hook', 'missing');
      }
      calls.push({ method: 'disable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: false, enabledSource: opts?.source });
    },
    async rollback(hookId, actorId, opts) {
      calls.push({ method: 'rollback', hookId, actorId, opts });
      overrides.delete(hookId);
    },
    async getOverride(hookId) {
      return overrides.get(hookId) ?? null;
    },
    async listOverrides() {
      return [...overrides.values()];
    },
  };
}

async function buildApp({ store = createFakeStore(), sessionUserId = OWNER } = {}) {
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionOverrideRoutes, { overrideStore: store });
  await app.ready();
  return { app, store };
}

describe('prompt-injection-overrides routes (F257 approval executor)', () => {
  before(() => {
    // Owner gate: configured owner must match session user for writes.
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
  });

  it('401 without session (read + write)', async () => {
    const { app } = await buildApp({ sessionUserId: null });
    const read = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(read.statusCode, 401);
    const write = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(write.statusCode, 401);
    await app.close();
  });

  it('403 when session user is not the configured owner', async () => {
    const { app, store } = await buildApp({ sessionUserId: 'someone-else' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'trial' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(store.calls.length, 0, 'store must not be touched');
    await app.close();
  });

  it('400 on missing/invalid action and on missing reason', async () => {
    const { app, store } = await buildApp();
    const badAction = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'set-content', reason: 'x' },
    });
    assert.equal(badAction.statusCode, 400);
    const noReason = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: '   ' },
    });
    assert.equal(noReason.statusCode, 400);
    assert.match(noReason.json().error, /reason/);
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  it('disable happy path: store called with operator source + actor + reason, override echoed', async () => {
    const { app, store } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'T1-F1 redundancy trial (operator approved)' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.override.enabled, false);
    assert.deepEqual(store.calls[0], {
      method: 'disable',
      hookId: 'd21-决策树',
      actorId: OWNER,
      opts: { source: 'operator', reason: 'T1-F1 redundancy trial (operator approved)' },
    });
    await app.close();
  });

  it('rollback happy path clears the override', async () => {
    const { app, store } = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'trial' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'rollback', reason: 'trial regressed — instant revert' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().override, null);
    assert.equal(store.calls.at(-1).method, 'rollback');
    await app.close();
  });

  it('gate errors map to HTTP: disableable=false → 409, unknown-hook → 404', async () => {
    const { app } = await buildApp();
    const policy = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/s1-immutable/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(policy.statusCode, 409);
    assert.equal(policy.json().gate, 'disableable');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/no-such-hook/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().gate, 'unknown-hook');
    await app.close();
  });

  it('GET lists current overrides (lifeline read surface)', async () => {
    const { app } = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'trial' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().overrides.length, 1);
    await app.close();
  });

  it('503 when override store unavailable (redis off)', async () => {
    const app = Fastify();
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = OWNER;
      done();
    });
    await app.register(promptInjectionOverrideRoutes, { overrideStore: undefined });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/d21-决策树/override',
      payload: { action: 'disable', reason: 'x' },
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});
