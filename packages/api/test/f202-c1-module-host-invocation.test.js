/**
 * F202 Train C1 — the Host→plugin direction over the in-process module carrier.
 *
 * This is the TypeScript shape of the SPI the operator described: the carrier already holds
 * what the package's `create(manifest)` returned, so calling a method the package declared is
 * a function call on that instance. No new transport, and nothing here is message-specific —
 * outbound delivery is one caller, a schedule firing would be another.
 *
 * REJECTION IS LOAD-BEARING, WHICH IS WHY THE NEGATIVE CASES MATTER MORE THAN THE HAPPY ONE.
 * Callers read a resolved promise as "the package accepted this work" — the delivery driver
 * advances its cursor on exactly that. So a method the package never implemented must reject
 * rather than quietly do nothing, or a message would be marked delivered while nobody ever
 * received it.
 *
 * DECLARED NAMES ARE NOT TRUSTED NAMES. The method name arrives from a package manifest, so it
 * is attacker-influenced input reaching a property lookup. `toString`, `constructor` and
 * `__proto__` all resolve to something callable on any object; invoking them would run
 * Host-side code the package never wrote and report success for it. Only a method the instance
 * actually owns may be called.
 *
 * STATUS when written: RED — `builtin-runtime/module-host-invocation.js` does not exist.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createModuleHostInvocation;
let invocation;
let loaded;
let calls;

const INSTANCE = 'inst-feishu';

beforeEach(async () => {
  ({ createModuleHostInvocation } = await import('../dist/domains/plugin/builtin-runtime/module-host-invocation.js'));
  calls = [];
  loaded = new Map();
  invocation = createModuleHostInvocation({
    runtime: {
      definedPlugin(pluginInstanceId) {
        return loaded.get(pluginInstanceId);
      },
    },
  });
});

function load(instanceId, methods) {
  loaded.set(instanceId, methods);
}

const INPUT = {
  deliveryId: 'delivery-1',
  threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
  envelope: {
    messageId: 'message-1',
    revision: 1,
    threadId: 'thread-1',
    actor: { kind: 'cat', id: 'opus' },
    audience: { kind: 'public' },
    occurredAt: '2026-09-21T00:00:00.000Z',
    payload: {
      provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
      elements: [{ elementId: 'e1', kind: 'text', payload: { text: 'hello' } }],
    },
  },
};

describe('F202 C1 — standard Host delivery over the module carrier', () => {
  test('case 1: calls only host.messaging.deliver with the frozen input and receipt', async () => {
    load(INSTANCE, {
      async 'host.messaging.deliver'(input) {
        calls.push(input);
        return { deliveryId: input.deliveryId };
      },
    });

    const result = await invocation.deliver(INSTANCE, INPUT);

    assert.deepEqual(calls, [INPUT]);
    assert.deepEqual(result, { deliveryId: INPUT.deliveryId });
  });

  test('case 2: a module without the standard delivery method rejects', async () => {
    load(INSTANCE, { outbound: async () => {} });

    await assert.rejects(
      () => invocation.deliver(INSTANCE, INPUT),
      (err) => err.code === 'PROTOCOL_VIOLATION',
      'silently succeeding would mark a message delivered that nobody received',
    );
  });

  test('case 3: a rejection from the package reaches the caller unchanged', async () => {
    const boom = new Error('feishu API is down');
    load(INSTANCE, {
      async 'host.messaging.deliver'() {
        throw boom;
      },
    });

    await assert.rejects(
      () => invocation.deliver(INSTANCE, INPUT),
      (err) => err === boom,
    );
  });

  test('case 4: calling an instance the Host is not holding rejects', async () => {
    await assert.rejects(
      () => invocation.deliver('inst-never-started', INPUT),
      (err) => err.code === 'INSTANCE_NOT_RUNNABLE',
    );
  });

  test('case 5: a mismatched delivery receipt rejects', async () => {
    load(INSTANCE, {
      async 'host.messaging.deliver'() {
        return { deliveryId: 'another-delivery' };
      },
    });

    await assert.rejects(
      () => invocation.deliver(INSTANCE, INPUT),
      (err) => err.code === 'PROTOCOL_VIOLATION',
    );
  });

  test('case 6: the module boundary rejects input outside the closed published schema', async () => {
    load(INSTANCE, {
      async 'host.messaging.deliver'(input) {
        calls.push(input);
        return { deliveryId: input.deliveryId };
      },
    });

    await assert.rejects(
      () => invocation.deliver(INSTANCE, { ...INPUT, method: 'outbound' }),
      (err) => err.code === 'PROTOCOL_VIOLATION',
    );
    assert.deepEqual(calls, [], 'invalid wire input must be rejected before package code runs');
  });
});
