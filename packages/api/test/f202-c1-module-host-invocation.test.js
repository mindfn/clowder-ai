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

describe('F202 C1 — Host→plugin invocation over the module carrier', () => {
  test('case 1: calls the method the package declared, with its params', async () => {
    load(INSTANCE, {
      async outbound(params) {
        calls.push(params);
      },
    });

    await invocation.invoke(INSTANCE, 'outbound', { event: 'e1' });

    assert.deepEqual(calls, [{ event: 'e1' }]);
  });

  test('case 2: a declared method the package never implemented rejects', async () => {
    load(INSTANCE, { outbound: async () => {} });

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'notImplemented', {}),
      (err) => err.code === 'PROTOCOL_VIOLATION',
      'silently succeeding would mark a message delivered that nobody received',
    );
  });

  test('case 3: a rejection from the package reaches the caller unchanged', async () => {
    const boom = new Error('feishu API is down');
    load(INSTANCE, {
      async outbound() {
        throw boom;
      },
    });

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'outbound', {}),
      (err) => err === boom,
    );
  });

  test('case 4: calling an instance the Host is not holding rejects', async () => {
    await assert.rejects(
      () => invocation.invoke('inst-never-started', 'outbound', {}),
      (err) => err.code === 'INSTANCE_NOT_RUNNABLE',
    );
  });

  test('case 5: inherited names are not callable methods', async () => {
    load(INSTANCE, { outbound: async () => {} });

    for (const name of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
      await assert.rejects(
        () => invocation.invoke(INSTANCE, name, {}),
        (err) => err.code === 'PROTOCOL_VIOLATION',
        `${name} resolves to something callable on every object and must not be invoked`,
      );
    }
  });

  test('case 6: a non-function own property is not callable either', async () => {
    load(INSTANCE, { outbound: 'not a function' });

    await assert.rejects(
      () => invocation.invoke(INSTANCE, 'outbound', {}),
      (err) => err.code === 'PROTOCOL_VIOLATION',
    );
  });
});
