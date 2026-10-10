import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import * as contexts from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';

const owner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner';

async function fixture(t, handler, { anonymous = false, timeoutMs = 1000 } = {}) {
  const webhooks = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw Error('unexpected package IO');
      },
    },
    configuration: { readConfig: async () => {}, readSecret: async () => {} },
  });
  await webhooks.activate(
    {
      instance: { pluginInstanceId: 'instance' },
      packageRecord: {
        pluginId: 'dev.clowder.owner-context',
        manifest: {
          contributions: [
            {
              type: 'webhook',
              id: 'owner',
              path: 'owner',
              methods: ['GET', 'POST'],
              action: { method: 'owner.call' },
              ...(anonymous ? { verificationSecretRef: 'secret' } : {}),
            },
          ],
        },
      },
      effectiveGrants: [],
    },
    handler,
  );
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', undefined);
  // Test auth seam: unlike the body principal, only this authenticated session reaches the Host guard.
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks, timeoutMs });
  return {
    app,
    webhooks,
    request: (method = 'GET', payload) =>
      app.inject({
        method,
        headers: { origin: 'http://localhost:5173' },
        url: '/api/plugins/dev.clowder.owner-context/owner',
        ...(payload ? { payload } : {}),
      }),
  };
}
function current() {
  return contexts.currentPluginOwnerRequestContext?.('instance');
}
test('anonymous webhooks never acquire owner authority from a session or body principal', async (t) => {
  let seen;
  const f = await fixture(
    t,
    async () => {
      seen = current();
      return { status: 200, body: {} };
    },
    { anonymous: true },
  );
  assert.equal((await f.request('POST', { principal: { kind: 'owner', id: 'owner' } })).statusCode, 200);
  assert.equal(seen, undefined);
});
test('authenticated forwarding captures Host identity independently of plugin business data', async (t) => {
  let captured;
  const f = await fixture(t, async (_id, _method, input) => {
    captured = current();
    input.request.principal.id = 'forged';
    return { status: 200, body: {} };
  });
  assert.equal((await f.request('POST', { userId: 'forged', principal: { id: 'forged' } })).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.equal(captured.userId, owner);
  assert.equal(captured.operation, 'write');
  assert.equal(Object.isFrozen(captured), true);
});
test('owner context is scoped to the exact activated instance and never supplies native identity', async (t) => {
  let captured, other, native;
  const f = await fixture(t, async () => {
    captured = current();
    other = contexts.currentPluginOwnerRequestContext?.('another-instance');
    native = contexts.currentPluginCallContext('instance');
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.equal(captured.operation, 'read');
  assert.equal(other, undefined);
  assert.equal(native, undefined);
});
test('completed request expires a saved owner context and its cancellation signal', async (t) => {
  let captured;
  const f = await fixture(t, async () => {
    captured = current();
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  await assert.rejects(() => captured.assertCurrent(), /no longer current/);
  assert.equal(captured.signal.aborted, true);
  assert.equal(current(), undefined);
});
test('HTTP timeout expires authority while an unfinished plugin callback is still alive', async (t) => {
  let captured, finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(
    t,
    async () => {
      captured = current();
      await pending;
      return { status: 200, body: {} };
    },
    { timeoutMs: 10 },
  );
  t.after(() => finish());
  assert.equal((await f.request()).statusCode, 504);
  assert.ok(captured, 'Host owner request context missing');
  await assert.rejects(() => captured.assertCurrent(), /no longer current/);
  assert.equal(captured.signal.aborted, true);
});
test('deactivating the contribution invalidates owner authority before callback completion', async (t) => {
  let captured, rejection;
  const f = await fixture(t, async () => {
    captured = current();
    f.webhooks.deactivate('instance');
    if (captured) {
      try {
        await captured.assertCurrent();
      } catch (error) {
        rejection = error;
      }
    }
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.match(rejection?.message ?? '', /no longer current/);
});

test('direct dispatch cannot manufacture owner authority from a request principal', async (t) => {
  let seen;
  const f = await fixture(t, async () => {
    seen = current();
    return { status: 200, body: {} };
  });
  await f.webhooks.callPluginWebhook('dev.clowder.owner-context', 'owner', { principal: { kind: 'owner', id: owner } });
  assert.equal(seen, undefined);
});
test('nested direct dispatch cannot reuse an authenticated route seed', async (t) => {
  let first,
    nested,
    calls = 0;
  const f = await fixture(t, async () => {
    if (++calls === 1) {
      first = current();
      await f.webhooks.callPluginWebhook('dev.clowder.owner-context', 'owner', {
        principal: { kind: 'owner', id: owner },
      });
      assert.equal(current(), first);
    } else nested = current();
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(first);
  assert.equal(nested, undefined);
});
test('verifier isolation clears HTTP authority and its route seed, then restores the caller', async (t) => {
  let isolated, saved;
  const f = await fixture(t, async () => {
    saved = current();
    isolated = await contexts.withoutPluginCallContext(async () => current());
    assert.equal(current(), saved);
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(saved);
  assert.equal(isolated, undefined);
});
test('native invocation entry clears HTTP authority without disturbing the outer owner request', async (t) => {
  let outer, nativeOwner;
  const f = await fixture(t, async () => {
    outer = current();
    await contexts.withPluginCallContext(
      'instance',
      { catId: 'cat', userId: owner, threadId: 'thread', invocationId: 'inv', assertCurrent: async () => {} },
      async () => {
        nativeOwner = current();
        assert.equal(contexts.currentPluginCallContext('instance').invocationId, 'inv');
      },
    );
    assert.equal(current(), outer);
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(outer);
  assert.equal(nativeOwner, undefined);
});
test('disconnected HTTP request invalidates a still-running package handler', async (t) => {
  let request, captured, rejected;
  const f = await fixture(t, async () => {
    captured = current();
    request.raw.emit('aborted');
    try {
      await captured.assertCurrent();
    } catch (error) {
      rejected = error;
    }
    return { status: 200, body: {} };
  });
  f.app.addHook('onRequest', async (value) => {
    request = value;
  });
  await f.request();
  assert.ok(captured);
  assert.match(rejected?.message ?? '', /no longer current/);
  assert.equal(captured.signal.aborted, true);
});
