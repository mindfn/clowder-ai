/**
 * Tests for unified callback auth preHandler (#476)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Callback Auth PreHandler (#476)', () => {
  /** Minimal InvocationRegistry mock */
  function createMockRegistry(records = new Map()) {
    return {
      verify(invocationId, callbackToken) {
        const record = records.get(invocationId);
        if (!record || record.callbackToken !== callbackToken) return null;
        return record;
      },
    };
  }

  async function buildApp(registry) {
    const { registerCallbackAuthHook, requireCallbackAuth } = await import(
      '../dist/routes/callback-auth-prehandler.js'
    );
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, registry);

    // Test route that requires auth
    app.get('/test/require-auth', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      return { threadId: record.threadId, catId: record.catId };
    });

    // Test route that optionally uses auth
    app.get('/test/optional-auth', async (request) => {
      return { hasAuth: !!request.callbackAuth };
    });

    await app.ready();
    return app;
  }

  const VALID_RECORD = {
    invocationId: 'inv-001',
    callbackToken: 'tok-001',
    threadId: 'thread-abc',
    catId: 'opus',
    userId: 'user-1',
  };

  it('decorates request.callbackAuth with verified record when headers are valid', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/require-auth',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'tok-001' },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.threadId, 'thread-abc');
    assert.equal(body.catId, 'opus');
    await app.close();
  });

  it('returns 401 when headers are missing and handler requires auth', async () => {
    const registry = createMockRegistry();
    const app = await buildApp(registry);

    const res = await app.inject({ method: 'GET', url: '/test/require-auth' });
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.ok(body.error.includes('expired'));
    await app.close();
  });

  it('returns 401 from preHandler when credentials are invalid (fail-closed, #474)', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/optional-auth',
      headers: { 'x-invocation-id': 'inv-001', 'x-callback-token': 'wrong-token' },
    });

    assert.equal(res.statusCode, 401, 'bad creds must be rejected at preHandler, not silently ignored');
    await app.close();
  });

  it('returns 401 from preHandler when only one header is present (malformed)', async () => {
    const registry = createMockRegistry(new Map([['inv-001', VALID_RECORD]]));
    const app = await buildApp(registry);

    const res = await app.inject({
      method: 'GET',
      url: '/test/optional-auth',
      headers: { 'x-invocation-id': 'inv-001' },
    });

    assert.equal(res.statusCode, 401, 'partial headers must be rejected, not treated as panel request');
    await app.close();
  });

  it('leaves callbackAuth undefined when headers absent (panel/optional path)', async () => {
    const registry = createMockRegistry();
    const app = await buildApp(registry);

    const res = await app.inject({ method: 'GET', url: '/test/optional-auth' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().hasAuth, false);
    await app.close();
  });
});
