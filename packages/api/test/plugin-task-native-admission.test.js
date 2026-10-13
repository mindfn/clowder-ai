import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerNativeTurnAdmissionRoute } from '../src/routes/callback-native-turn-admission.ts';

const path = '/api/callbacks/native-turn-admission';
const policy = {
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'private',
  actionMethods: ['work.read'],
};
const binding = {
  version: 1,
  pluginInstanceId: 'instance',
  ownerUserId: 'owner',
  taskId: 'task',
  taskRevision: 2,
  targetCatId: 'codex',
  threadId: 'thread',
  admissionRef: 'message:admission',
  executionRef: 'message:execution',
  sourceMessageId: 'source',
  sourceRevision: 1,
  triggerMessageId: 'dispatch',
  packageDigest: 'digest',
  lifecycleRevision: 3,
  grantRevision: 2,
};
async function fixture(kind = 'private', registryAtRoute = true) {
  let current = true,
    running = true,
    hook;
  const registry = new InvocationRegistry({
    turnExecutionStore: {
      get: async (invocationId) => ({
        invocationId,
        status: running ? 'running' : 'failed',
        updatedAt: 1,
        ...(running ? {} : { endedAt: 1 }),
      }),
    },
    assertPluginTaskCurrent: async () => {
      if (!current) throw Error('Task changed');
    },
  });
  const create = () =>
    registry.create(
      'owner',
      'codex',
      'thread',
      undefined,
      undefined,
      kind === 'ordinary' ? undefined : policy,
      'dispatch',
      'unknown',
      undefined,
      undefined,
      kind === 'private' ? binding : undefined,
    );
  const creds = await create();
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  app.addHook('preHandler', async () => {
    await hook?.();
  });
  registerNativeTurnAdmissionRoute(app, registryAtRoute ? registry : undefined);
  app.get('/api/callbacks/other', async () => ({ unexpected: true }));
  const get = (url = `${path}?scope=plugin_task`, headers = {}) =>
    app.inject({
      method: 'GET',
      url,
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken, ...headers },
    });
  return {
    app,
    registry,
    creds,
    create,
    get,
    mutate: (fn) => {
      hook = fn;
    },
    stop: () => {
      running = false;
    },
    revoke: () => {
      current = false;
    },
    restore: () => {
      current = true;
    },
  };
}

test('ordinary F317 admission remains204 while explicit Task scope cannot borrow ordinary authority', async (t) => {
  const f = await fixture('ordinary');
  t.after(() => f.app.close());
  assert.equal((await f.get(path)).statusCode, 204);
  assert.equal((await f.get()).statusCode, 403);
  assert.equal((await f.get(`${path}?scope=typo`)).statusCode, 400);
  assert.equal((await f.get(`${path}?scope=plugin_task&scope=plugin_task`)).statusCode, 400);
});
test('Task scoped admission accepts only live exact Task identity and returns no credentials or body', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const result = await f.get();
  assert.equal(result.statusCode, 204);
  assert.equal(result.body, '');
  assert.equal((await f.get(path)).statusCode, 403, 'private principal cannot downgrade to ordinary probe');
  assert.equal((await f.get('/api/callbacks/other?scope=plugin_task')).statusCode, 403);
  assert.equal((await f.get(undefined, { 'x-callback-token': 'invalid' })).statusCode, 401);
});
test('public native policy and an absent Task verifier fail closed for Task admission', async (t) => {
  const publicNative = await fixture('public');
  t.after(() => publicNative.app.close());
  assert.equal((await publicNative.get()).statusCode, 403);
  const unbound = await fixture('private', false);
  t.after(() => unbound.app.close());
  assert.equal((await unbound.get()).statusCode, 403);
});
test('Task invalidation between preHandler and handler revokes the attempt permanently', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  f.mutate(f.revoke);
  assert.equal((await f.get()).statusCode, 401);
  f.mutate(undefined);
  f.restore();
  assert.equal((await f.get()).statusCode, 401);
  assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, false);
});
test('latest replacement and canonical termination after preHandler cannot authorize scoped admission', async (t) => {
  for (const replacement of [false, true]) {
    const f = await fixture();
    t.after(() => f.app.close());
    f.mutate(replacement ? f.create : f.stop);
    assert.equal((await f.get()).statusCode, 401);
  }
});

test('agent keys and absent credentials cannot satisfy private Task admission', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerCallbackAuthHook(
    app,
    { verify: async () => ({ ok: false, reason: 'invalid_token' }) },
    {
      agentKeyRegistry: {
        verify: async () => ({
          ok: true,
          record: { agentKeyId: 'key', catId: 'codex', userId: 'owner', scope: 'project' },
        }),
      },
    },
  );
  registerNativeTurnAdmissionRoute(app);
  assert.equal((await app.inject({ method: 'GET', url: `${path}?scope=plugin_task` })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `${path}?scope=plugin_task`,
        headers: { 'x-agent-key-secret': 'fixture-secret' },
      })
    ).statusCode,
    403,
  );
});
