import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import {
  currentOwnerOperation,
  withCurrentOwnerOperation,
} from '../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import {
  currentPluginOwnerRequestContext,
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../dist/domains/plugin/carrier/plugin-owner-request-context.js';
import { currentPluginTransportPurpose } from '../dist/domains/plugin/carrier/plugin-transport-context.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

const privateMethod = 'host.public-invocation.assert-current';
const manifest = {
  pluginId: 'dev.clowder.public-verifier-fixture',
  version: '0.1.0',
  contractVersion: '0.1.0',
  name: 'Public verifier fixture',
  runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
  features: [
    {
      id: 'public',
      name: 'Public',
      resources: [],
      capabilities: ['thread.readContent'],
      contributions: [{ type: 'mcp', id: 'native' }],
    },
  ],
  contributions: [
    {
      type: 'mcp',
      id: 'native',
      runtime: { transport: 'stdio', entrypoint: 'mcp.mjs' },
      actions: [{ method: 'native.reply' }],
    },
  ],
};
function carrier() {
  return {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: 'source',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'fixture-digest',
    lifecycleRevision: 1,
    grantRevision: 1,
    contributionId: 'native',
    actionMethods: ['native.reply'],
    targetCatId: 'astra',
    authorityRef: 'participation:1',
    authorityRevision: 'revision:1',
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  t,
  { handler = async () => ({ current: true }), slot, actions = {}, grants = ['thread.readContent'] } = {},
) {
  const validation = validateManifest(manifest);
  assert.equal(
    validation.valid,
    true,
    `invalid public verifier fixture manifest: ${JSON.stringify(validation.errors)}`,
  );
  t.diagnostic('verified public verifier fixture manifest');
  const rootDir = await mkdtemp(join(tmpdir(), 'plugin-public-verifier-'));
  const key = randomUUID();
  let activation;
  const hook = {
    handler,
    actions,
    capture(value) {
      activation = value;
      return value;
    },
  };
  globalThis[key] = hook;
  const property = slot ?? 'publicInvocationVerifier: (...args) => hook.handler(...args),';
  await writeFile(
    join(rootDir, 'plugin.mjs'),
    `const hook = globalThis[${JSON.stringify(key)}];
    export default { create() { return { start() { return hook.capture({ actions: hook.actions,
      ${property} stop() {}
    }); } }; } };`,
  );
  await writeFile(join(rootDir, 'mcp.mjs'), 'throw new Error("This fixture must never launch an MCP process");');
  const packages = {
    resolveInstalledPackage: async () => ({
      rootDir,
      manifest: structuredClone(manifest),
      verifyIntegrity: async () => {},
      release: async () => {},
    }),
  };
  const runtime = new ModulePluginRuntime({
    packages,
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    log() {},
  });
  let stop = () => runtime.stop('instance', 'test_cleanup');
  t.after(async () => {
    await stop();
    delete globalThis[key];
    await rm(rootDir, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const context = { signal: controller.signal, assertCurrent: async () => {} };
  return {
    rootDir,
    packages,
    setCleanup: (fn) => {
      stop = fn;
    },
    runtime,
    controller,
    context,
    hook,
    activation: () => activation,
    start: () =>
      runtime.start(
        'instance',
        { pluginId: manifest.pluginId, packageDigest: 'fixture-digest', manifest: structuredClone(manifest) },
        grants,
      ),
    invoke(value = carrier(), authority = context) {
      assert.equal(
        typeof runtime.invokePublicInvocationVerifier,
        'function',
        'missing private public verifier carrier',
      );
      return runtime.invokePublicInvocationVerifier('instance', value, authority);
    },
  };
}

test('public verifier receives detached frozen coordinates under private purpose, without native identity', async (t) => {
  let received;
  let retained;
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: async (input, context) => {
      received = input;
      retained = context;
      assert.equal(currentPluginCallContext('other-instance'), undefined);
      assert.equal(currentPluginCallContext('instance'), undefined);
      assert.equal(currentPluginTransportPurpose(), 'verifier');
      assert.deepEqual(Object.keys(context).sort(), ['assertCurrent', 'signal']);
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.native.methods) && Object.isFrozen(context));
      entered.resolve();
      await release.promise;
      await context.assertCurrent();
      return { current: true };
    },
  });
  await f.start();
  const original = carrier();
  const pending = withPluginCallContext(
    'other-instance',
    {
      catId: 'owner-cat',
      threadId: 'private',
      userId: 'owner',
      invocationId: 'owner-turn',
      assertCurrent: async () => {},
    },
    () => f.invoke(original),
  );
  pending.catch(() => entered.resolve());
  await entered.promise;
  original.targetCatId = 'other-cat';
  original.authorityRevision = 'other-revision';
  original.actionMethods.push('native.admin');
  release.resolve();
  const result = await pending;
  assert.deepEqual(received, {
    authority: { ref: 'participation:1', revision: 'revision:1' },
    source: { messageRef: 'message:source' },
    targetCatId: 'astra',
    native: { contributionId: 'native', methods: ['native.reply'] },
  });
  assert.deepEqual(result, { current: true });
  assert.ok(Object.isFrozen(result));
  await assert.rejects(() => retained.assertCurrent());
  assert.equal(f.runtime.exposesAction('instance', privateMethod), false);
  await assert.rejects(() => f.runtime.invoke('instance', privateMethod, {}));
});

async function routedFixture(t, options = {}) {
  const f = await fixture(t, options);
  const instance = {
    pluginInstanceId: 'instance',
    pluginId: manifest.pluginId,
    packageDigest: 'fixture-digest',
    lifecycleRevision: 1,
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
  };
  const pkg = {
    pluginId: manifest.pluginId,
    packageDigest: 'fixture-digest',
    packageState: 'installed',
    manifest: structuredClone(manifest),
  };
  const grant = { pluginInstanceId: 'instance', grantRevision: 1, effectiveGrants: ['thread.readContent'] };
  const state = { instances: [instance], packages: [pkg], grants: [grant] };
  const inventory = {
    snapshot: async () => structuredClone(state),
    transaction: async (fn) =>
      fn({
        instances: {
          get: (id) => state.instances.find((row) => row.pluginInstanceId === id),
          put: (row) => {
            state.instances[state.instances.findIndex((old) => old.pluginInstanceId === row.pluginInstanceId)] = row;
          },
        },
      }),
  };
  const bundled = new BundledPluginRuntimeCarrier({ inventory, runtimes: [f.runtime] });
  // Installed package bytes and Host materialized resources live in separate roots.
  const projectRoot = await mkdtemp(join(tmpdir(), 'plugin-public-verifier-project-'));
  let config = { version: 1, capabilities: [] };
  const router = new PluginRuntimeCarrierRouter(
    inventory,
    {
      projectRoot,
      packages: f.packages,
      configuration: { resolve: async () => ({}) },
      mcpConfigIO: {
        readConfig: async () => config,
        withLock: async (fn) => fn(),
        writeAndRegenCli: async (value) => {
          config = structuredClone(value);
        },
      },
    },
    undefined,
    undefined,
    options.publicInvocationSources,
  );
  router.register(bundled);
  f.setCleanup(async () => {
    try {
      await router.stopAll('test_cleanup');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
  await router.start('instance');
  return {
    ...f,
    router,
    bundled,
    state,
    grant,
    pkg,
    invoke: (value = carrier(), ctx = f.context) => router.invokePublicInvocationVerifier('instance', value, ctx),
  };
}

test('public verifier suppresses owner HTTP and owner operation context without damaging the outer caller', async (t) => {
  const f = await fixture(t, {
    handler: async () => {
      assert.equal(currentOwnerOperation('instance'), undefined);
      assert.equal(currentPluginOwnerRequestContext('instance'), undefined);
      await Promise.resolve();
      assert.equal(currentPluginOwnerRequestContext('instance'), undefined);
      return { current: true };
    },
  });
  await f.start();
  const operation = {
    kind: 'owner-operation',
    pluginInstanceId: 'instance',
    userId: 'owner',
    operationKey: 'setting',
    actionId: 'save',
    requestId: 'request',
    signal: f.context.signal,
    assertCurrent: async () => {},
  };
  await withCurrentOwnerOperation(operation, () =>
    withPluginOwnerRequest(
      {
        pluginId: manifest.pluginId,
        contributionId: 'owner',
        userId: 'owner',
        operation: 'read',
        signal: f.context.signal,
      },
      () =>
        withPluginOwnerWebhook(
          manifest.pluginId,
          'owner',
          'instance',
          false,
          () => {},
          async () => {
            assert.equal(currentOwnerOperation('instance'), operation);
            assert.equal(currentPluginOwnerRequestContext('instance').userId, 'owner');
            assert.deepEqual(await f.invoke(), { current: true });
            assert.equal(currentOwnerOperation('instance'), operation);
            assert.equal(currentPluginOwnerRequestContext('instance').userId, 'owner');
          },
        ),
    ),
  );
});

test('a package cannot swallow a failed current fence and then return success', async (t) => {
  let fail = false;
  const f = await fixture(t, {
    handler: async (_input, ctx) => {
      fail = true;
      await assert.rejects(() => ctx.assertCurrent());
      fail = false;
      return { current: true };
    },
  });
  await f.start();
  f.context.assertCurrent = async () => {
    if (fail) throw new Error('authority revoked');
  };
  await assert.rejects(() => f.invoke());
});

test('actual Router to Bundled to Module chain uses the private verifier and never ordinary invoke', async (t) => {
  let calls = 0;
  const f = await routedFixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  assert.deepEqual(await f.invoke(), { current: true });
  assert.equal(calls, 1);
  for (const runtime of [f.router, f.bundled, f.runtime]) {
    assert.equal(await runtime.exposesAction('instance', privateMethod), false);
    await assert.rejects(() => runtime.invoke('instance', privateMethod, carrier()));
  }
  assert.equal(calls, 1);
});

for (const [name, mutate] of [
  [
    'disabled instance',
    (f) => {
      f.state.instances[0].activationState = 'disabled';
    },
  ],
  [
    'lifecycle revision',
    (f) => {
      f.state.instances[0].lifecycleRevision++;
    },
  ],
  [
    'grant revision',
    (f) => {
      f.grant.grantRevision++;
    },
  ],
  [
    'effective grants without revision change',
    (f) => {
      f.grant.effectiveGrants = [];
    },
  ],
  [
    'package mutation under same digest',
    (f) => {
      f.pkg.manifest.name = 'Changed';
    },
  ],
]) {
  test(`routed public verifier rejects ${name} before entering the package`, async (t) => {
    let calls = 0;
    const f = await routedFixture(t, {
      handler: () => {
        calls++;
        return { current: true };
      },
    });
    mutate(f);
    await assert.rejects(() => f.invoke());
    assert.equal(calls, 0);
  });
}

test('routed public verifier rejects authority revision changed while package work is pending', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await routedFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.invoke();
  const rejected = assert.rejects(pending);
  await entered.promise;
  f.grant.grantRevision++;
  release.resolve();
  await rejected;
});

test('routed stop cancels pending verifier without waiting for the package', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await routedFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.invoke();
  const rejected = assert.rejects(pending);
  await entered.promise;
  await f.router.stop('instance', 'revoked');
  await rejected;
  release.resolve();
});

test('missing private verifier fails closed and never calls an ordinary fallback', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    slot: '',
    actions: {
      'native.reply': () => {
        calls++;
        return { current: true };
      },
    },
  });
  await f.start();
  await assert.rejects(async () => f.invoke());
  assert.equal(calls, 0);
  // A missing API is an implementation gap, not evidence that a rejection path exists.
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
});

test('private verifier rejects instance, digest, contribution and undeclared method mismatches before package entry', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  for (const delta of [
    { pluginInstanceId: 'other' },
    { packageDigest: 'other' },
    { contributionId: 'other' },
    { actionMethods: ['native.admin'] },
    { actionMethods: [] },
  ]) {
    await assert.rejects(() => f.invoke({ ...carrier(), ...delta }));
  }
  assert.equal(calls, 0);
});

test('activation captures the verifier function rather than rereading a mutable returned object', async (t) => {
  let oldCalls = 0;
  let replacementCalls = 0;
  const f = await fixture(t, {
    handler: () => {
      oldCalls++;
      return { current: true };
    },
  });
  await f.start();
  f.activation().publicInvocationVerifier = () => {
    replacementCalls++;
    return { current: true };
  };
  assert.deepEqual(await f.invoke(), { current: true });
  assert.equal(oldCalls, 1);
  assert.equal(replacementCalls, 0);
});

test('authority is checked across awaits and the original fence cannot be replaced by the caller', async (t) => {
  let valid = true;
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  const ctx = {
    signal: f.context.signal,
    assertCurrent: async () => {
      entered.resolve();
      await release.promise;
      assert.ok(valid, 'authority revoked');
    },
  };
  const pending = Promise.resolve().then(() => f.invoke(carrier(), ctx));
  pending.catch(() => entered.resolve());
  await entered.promise;
  ctx.assertCurrent = async () => {};
  valid = false;
  release.resolve();
  await assert.rejects(pending, /authority revoked/);
  assert.equal(calls, 0);
});

for (const reason of ['stop', 'abort']) {
  test(`pending public verifier rejects on ${reason} and ignores late success`, async (t) => {
    const entered = deferred();
    const release = deferred();
    let retained;
    const f = await fixture(t, {
      handler: async (_input, ctx) => {
        retained = ctx;
        entered.resolve();
        await release.promise;
        return { current: true };
      },
    });
    await f.start();
    assert.equal(
      typeof f.runtime.invokePublicInvocationVerifier,
      'function',
      'missing private public verifier carrier',
    );
    const pending = f.invoke();
    const rejected = assert.rejects(pending);
    await entered.promise;
    if (reason === 'stop') await f.runtime.stop('instance', 'revoked');
    else f.controller.abort();
    // Cancellation must settle without cooperation from the package handler.
    await rejected;
    release.resolve();
    await assert.rejects(() => retained.assertCurrent());
  });
}

test('private verifier accepts only current true and forbids result fields that could replace authority', async (t) => {
  let result;
  const f = await fixture(t, { handler: () => result });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  for (result of [
    undefined,
    null,
    true,
    { current: false },
    { current: true, targetCatId: 'other' },
    { current: true, native: { methods: ['admin'] } },
  ]) {
    await assert.rejects(() => f.invoke());
  }
});

for (const [name, slot] of [
  ['accessor', 'get publicInvocationVerifier() { throw new Error("accessor must not execute"); },'],
  ['inherited', '__proto__: { publicInvocationVerifier: () => ({ current: true }) },'],
  ['nonfunction', 'publicInvocationVerifier: {},'],
]) {
  test(`activation rejects a ${name} public verifier slot`, async (t) => {
    const f = await fixture(t, { slot });
    await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
  });
}

test('fixed private verifier name cannot be registered as an ordinary action', async (t) => {
  const f = await fixture(t, { actions: { [privateMethod]: () => ({ current: true }) } });
  await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
});

test('a public verifier cannot approve an MCP contribution whose owning feature is not granted', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    grants: [],
    handler: () => {
      calls++;
      return { current: true };
    },
  });
  await f.start();
  assert.equal(typeof f.runtime.invokePublicInvocationVerifier, 'function', 'missing private public verifier carrier');
  await assert.rejects(() => f.invoke());
  assert.equal(calls, 0);
});

async function publicSourceFixture(t, options = {}) {
  const message = {
    id: 'source',
    userId: 'owner',
    threadId: 'public-thread',
    catId: null,
    content: 'public source body',
    timestamp: 1000,
    mentions: [],
    deliveryStatus: 'queued',
    source: { connector: 'fixture', meta: { channel: 'public' } },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 }, privateSecret: 'do not project' },
    queueCustody: makeQueuedMessageCustody({
      ownerUserId: 'owner',
      ownerAuthProvenance: 'unknown',
      intent: 'execute',
      allTargetCats: ['astra'],
      pendingTargetCats: ['astra'],
      pluginPublicInvocation: carrier(),
    }),
  };
  const thread = { id: 'public-thread', createdBy: 'owner', participants: ['astra'] };
  const stores = {
    ownerUserId: 'owner',
    messageStore: { getById: async (id) => (id === message.id ? structuredClone(message) : null) },
    threadStore: { get: async (id) => (id === thread.id ? structuredClone(thread) : null) },
  };
  let entered = 0;
  const f = await routedFixture(t, {
    publicInvocationSources: stores,
    handler: async (input, context) => {
      entered++;
      return options.handler ? options.handler(input, context) : { current: true };
    },
  });
  const binding = { entryId: 'entry-1', userId: 'owner', threadId: thread.id, targetCatId: 'astra' };
  assert.equal(typeof f.router.assertPublicInvocationCurrent, 'function', 'missing durable public currentness fence');
  return {
    ...f,
    message,
    thread,
    stores,
    binding,
    entered: () => entered,
    check: (value = carrier(), expected = binding, context = f.context) =>
      f.router.assertPublicInvocationCurrent('instance', value, expected, context),
  };
}

test('public source fence verifies durable custody through the real private runtime chain', async (t) => {
  const f = await publicSourceFixture(t);
  assert.equal(await f.check(), undefined);
  assert.equal(f.entered(), 1);
  assert.equal(f.message.deliveryStatus, 'queued');
  assert.equal(f.message.queueCustody.status, 'queued');
});

test('public source fence rejects missing, recalled, deleted, foreign and malformed sources before package entry', async (t) => {
  const f = await publicSourceFixture(t);
  const original = structuredClone(f.message);
  for (const delta of [
    { id: 'missing' },
    { userId: 'foreign' },
    { catId: 'astra' },
    { threadId: 'foreign' },
    { recall: { recalledAt: 1 } },
    { deletedAt: 1 },
    { _tombstone: true },
    { sourceParseFailure: {} },
    { source: undefined },
    { deliveryStatus: 'canceled' },
    { extra: { pluginMessage: { instanceId: 'other', revision: 1 } } },
    { extra: { pluginMessage: { instanceId: 'instance', revision: 2 } } },
  ]) {
    for (const key of Object.keys(f.message)) delete f.message[key];
    Object.assign(f.message, structuredClone(original), delta);
    await assert.rejects(() => f.check());
  }
  assert.equal(f.entered(), 0);
});

test('public source fence rejects absent or substituted durable authority and owner lanes', async (t) => {
  const f = await publicSourceFixture(t);
  const original = structuredClone(f.message.queueCustody);
  for (const delta of [
    { pluginPublicInvocation: undefined },
    { pluginPublicInvocation: { ...carrier(), authorityRevision: 'other' } },
    { entryId: 'another-entry' },
    { ownerUserId: 'foreign' },
    { ownerAuthProvenance: 'owner_authenticated' },
    { allTargetCats: ['astra', 'codex'], pendingTargetCats: ['astra', 'codex'] },
  ]) {
    f.message.queueCustody = { ...structuredClone(original), ...delta };
    await assert.rejects(() => f.check());
  }
  f.message.queueCustody = undefined;
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});

test('public source fence rejects terminal, failed and withdrawn targets without requeue', async (t) => {
  const f = await publicSourceFixture(t);
  const original = structuredClone(f.message.queueCustody);
  for (const delta of [
    { status: 'terminal', pendingTargetCats: [], handledByCatIds: ['astra'] },
    { failedByCatIds: ['astra'] },
    { withdrawnByCatIds: ['astra'], withdrawnAtByCatId: { astra: 1001 } },
    { pendingTargetCats: [] },
  ]) {
    f.message.queueCustody = { ...structuredClone(original), ...delta };
    await assert.rejects(() => f.check());
    assert.deepEqual(f.message.queueCustody, { ...original, ...delta });
  }
  assert.equal(f.entered(), 0);
});

test('public source fence requires current owner thread and target participation', async (t) => {
  const f = await publicSourceFixture(t);
  for (const thread of [
    null,
    { ...f.thread, createdBy: 'foreign' },
    { ...f.thread, deletedAt: 1 },
    { ...f.thread, participants: [] },
    { ...f.thread, id: 'other' },
  ]) {
    f.stores.threadStore.get = async () => thread;
    await assert.rejects(() => f.check());
  }
  assert.equal(f.entered(), 0);
});

test('public source fence rejects malformed caller bindings before store reads', async (t) => {
  const f = await publicSourceFixture(t);
  let reads = 0;
  f.stores.messageStore.getById = async () => {
    reads++;
    return f.message;
  };
  for (const delta of [
    { userId: 'foreign' },
    { targetCatId: 'codex' },
    { entryId: '' },
    { threadId: '' },
    { workspace: '/private' },
    { invocationId: '' },
  ]) {
    await assert.rejects(() => f.check(carrier(), { ...f.binding, ...delta }));
  }
  assert.equal(reads, 0);
});

test('public source fence rejects source body drift during thread lookup even without a revision bump', async (t) => {
  const f = await publicSourceFixture(t);
  f.stores.threadStore.get = async () => {
    f.message.content = 'replaced';
    return f.thread;
  };
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});

test('public source fence rejects source withdrawal while package verification awaits', async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await publicSourceFixture(t, {
    handler: async () => {
      entered.resolve();
      await release.promise;
      return { current: true };
    },
  });
  const pending = f.check();
  await entered.promise;
  f.message.recall = { recalledAt: 1001 };
  release.resolve();
  await assert.rejects(() => pending);
});

test('public source fence cannot lose a failed source check swallowed by the package', async (t) => {
  let f;
  f = await publicSourceFixture(t, {
    handler: async (_input, context) => {
      f.thread.participants = [];
      await assert.rejects(() => context.assertCurrent());
      f.thread.participants = ['astra'];
      return { current: true };
    },
  });
  await assert.rejects(() => f.check());
});

test('public source fence captures carrier and binding before awaited reads', async (t) => {
  const f = await publicSourceFixture(t);
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const value = carrier(),
    binding = { ...f.binding };
  const pending = f.check(value, binding);
  await entered.promise;
  value.authorityRevision = 'mutated';
  value.actionMethods.push('native.admin');
  binding.entryId = 'mutated';
  release.resolve();
  assert.equal(await pending, undefined);
});

test('public source fence binds callbacks to the exact durable awakened child', async (t) => {
  const f = await publicSourceFixture(t);
  f.message.queueCustody.status = 'processing';
  f.message.queueCustody.processingStartedAt = 1001;
  f.message.queueCustody.awakenedInvocationIdByCatId = { astra: 'child-1' };
  f.message.queueCustody.awakenedAtByCatId = { astra: 1001 };
  await f.check(carrier(), { ...f.binding, invocationId: 'child-1' });
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-2' }));
  await assert.rejects(() => f.check(carrier(), f.binding));
  f.message.queueCustody.status = 'queued';
  await assert.rejects(() => f.check(carrier(), f.binding));
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-1' }));
  f.message.queueCustody.status = 'processing';
  delete f.message.queueCustody.awakenedInvocationIdByCatId;
  delete f.message.queueCustody.awakenedAtByCatId;
  await assert.rejects(() => f.check(carrier(), f.binding));
  await assert.rejects(() => f.check(carrier(), { ...f.binding, invocationId: 'child-1' }));
});

test('public source fence rejects stopped activation and aborted calls', async (t) => {
  const f = await publicSourceFixture(t);
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  await assert.rejects(() => f.check(carrier(), f.binding, { ...f.context, signal: abort.signal }));
  await f.router.stop('instance', 'owner_disabled');
  await assert.rejects(() => f.check());
  assert.equal(f.entered(), 0);
});

test('public source fence rechecks activation during source reads after package verification', async (t) => {
  let verified = false;
  const f = await publicSourceFixture(t, {
    handler: async () => {
      verified = true;
      return { current: true };
    },
  });
  const get = f.stores.messageStore.getById;
  let stopped = false;
  f.stores.messageStore.getById = async (id) => {
    const message = await get(id);
    if (verified && !stopped) {
      stopped = true;
      await f.router.stop('instance', 'disabled_during_final_source_read');
    }
    return message;
  };
  await assert.rejects(() => f.check());
  assert.equal(verified, true);
  assert.equal(stopped, true);
});

test('public source fence abort settles blocked storage reads without entering the package', async (t) => {
  const f = await publicSourceFixture(t);
  const entered = deferred(),
    release = deferred();
  const get = f.stores.messageStore.getById;
  f.stores.messageStore.getById = async (id) => {
    entered.resolve();
    await release.promise;
    return get(id);
  };
  const controller = new AbortController();
  const pending = f.check(carrier(), f.binding, { ...f.context, signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('abort_storage_read'));
  try {
    await assert.rejects(() => pending, /abort_storage_read/);
    assert.equal(f.entered(), 0);
  } finally {
    release.resolve();
  }
});
