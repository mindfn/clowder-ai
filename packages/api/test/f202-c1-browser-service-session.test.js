import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.js';

const declaration = {
  type: 'browser-service',
  id: 'client-api',
  action: { method: 'service.http' },
  routes: [{ method: 'GET', path: '/api/health', browser: 'service', local: 'omit-origin' }],
  credentials: { bearer: true, cookies: [] },
};
function manifest(browser = true, collision = false) {
  return {
    pluginId: 'dev.clowder.browser-session-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Browser session fixture',
    runtime: { transport: 'builtin', entrypoint: 'plugin.mjs' },
    features: [
      {
        id: 'service',
        name: 'Service',
        resources: [],
        capabilities: [],
        ...(browser ? { contributions: [{ type: declaration.type, id: declaration.id }] } : {}),
      },
    ],
    ...(browser ? { contributions: [declaration] } : {}),
    ...(collision
      ? {
          configuration: [
            {
              key: 'service',
              kind: 'operation',
              label: 'Service',
              required: false,
              actions: [{ id: 'call', label: 'Call', render: 'status', action: { method: 'service.http' } }],
            },
          ],
        }
      : {}),
  };
}
async function fixture(
  t,
  {
    browser = true,
    startFails = false,
    publishFails = false,
    missingHandler = false,
    collision = false,
    stopFailsOnce = false,
  } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-browser-session-'));
  const key = randomUUID(),
    events = [];
  const declared = manifest(browser, collision);
  assert.equal(validateManifest(declared).valid, true);
  let hostSeen,
    sessionInput,
    capturedHandlers,
    stops = 0;
  const hostPort = Object.freeze({
    getBinding: async () => {
      throw Error('No network binding in carrier-only fixture');
    },
    dispatchLocal: async () => {
      throw Error('No transport in carrier-only fixture');
    },
  });
  globalThis[key] = {
    start(host) {
      events.push('module-start');
      hostSeen = host;
      if (startFails) throw Error('package start failed');
    },
    stop() {
      events.push('module-stop');
    },
  };
  await writeFile(
    join(rootDir, 'plugin.mjs'),
    `export default { create() { return { start(host) {
    globalThis[${JSON.stringify(key)}].start(host);
    return { actions: { public: async () => 'public', ${browser && !missingHandler ? "'service.http': async () => ({status:200,headers:[],bodyBase64:''})," : ''} },
      stop() { globalThis[${JSON.stringify(key)}].stop(); } };
  } }; } };`,
  );
  const runtime = new ModulePluginRuntime({
    packages: {
      resolveInstalledPackage: async () => ({
        rootDir,
        manifest: declared,
        verifyIntegrity: async () => {},
        release: async () => {
          events.push('release');
        },
      }),
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    browserServices: async (input) => {
      events.push('prepare');
      sessionInput = input;
      return {
        host: hostPort,
        publish: async (handlers) => {
          events.push('publish');
          capturedHandlers = handlers;
          if (publishFails) throw Error('publish failed');
        },
        stop: async () => {
          events.push('session-stop');
          stops++;
          assert.equal(input.signal.aborted, true);
          if (stopFailsOnce && stops === 1) throw Error('close failed once');
        },
      };
    },
    log() {},
  });
  t.after(async () => {
    await runtime.stop('instance', 'test-cleanup');
    delete globalThis[key];
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    runtime,
    events,
    host: () => hostSeen,
    input: () => sessionInput,
    handlers: () => capturedHandlers,
    hostPort,
    start: () =>
      runtime.start(
        'instance',
        { pluginId: declared.pluginId, packageDigest: 'fixture-digest', manifest: declared },
        [],
      ),
  };
}

test('ordinary module does not allocate a browser-service session', async (t) => {
  const f = await fixture(t, { browser: false });
  await f.start();
  assert.equal(await f.runtime.invoke('instance', 'public', {}), 'public');
  assert.equal(f.host().browserServices, undefined);
  await f.runtime.stop('instance', 'disable');
  assert.deepEqual(f.events, ['module-start', 'module-stop', 'release']);
});
test('browser resource is prepared before module start and published only after admission', async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal(f.host().browserServices, f.hostPort);
  assert.deepEqual(f.events, ['prepare', 'module-start', 'publish']);
  assert.equal(f.input().pluginInstanceId, 'instance');
  assert.equal(f.input().packageRecord.packageDigest, 'fixture-digest');
  assert.equal(typeof f.handlers().get('client-api'), 'function');
  await f.runtime.stop('instance', 'disable');
  assert.deepEqual(f.events, ['prepare', 'module-start', 'publish', 'session-stop', 'module-stop', 'release']);
});
test('startup failure releases browser resources even without a module disposer', async (t) => {
  const f = await fixture(t, { startFails: true });
  await assert.rejects(f.start, /package start failed/);
  assert.deepEqual(f.events, ['prepare', 'module-start', 'session-stop', 'release']);
});
test('publication failure revokes the session before disposing the module', async (t) => {
  const f = await fixture(t, { publishFails: true });
  await assert.rejects(f.start, /publish failed/);
  assert.deepEqual(f.events, ['prepare', 'module-start', 'publish', 'session-stop', 'module-stop', 'release']);
  assert.equal(f.runtime.actions('instance'), undefined);
});
test('browser handlers never appear in ordinary action lookup or invocation', async (t) => {
  const f = await fixture(t);
  await f.start();
  assert.equal(f.runtime.exposesAction('instance', 'service.http'), false);
  assert.equal(Object.hasOwn(f.runtime.actions('instance'), 'service.http'), false);
  const result = await f.runtime.attemptInvoke('instance', 'service.http', {});
  assert.equal(result.effect, 'not_started');
  await assert.rejects(() => f.runtime.invoke('instance', 'service.http', {}), { code: 'PROTOCOL_VIOLATION' });
  assert.equal(await f.runtime.invoke('instance', 'public', {}), 'public');
});
test('contract rejects browser method collision with a configuration action', () => {
  assert.equal(validateManifest(manifest(true, true)).valid, false);
});
test('missing declared browser handler rolls back the owned reservation', async (t) => {
  const f = await fixture(t, { missingHandler: true });
  await assert.rejects(f.start, { code: 'PROTOCOL_VIOLATION' });
  assert.deepEqual(f.events, ['prepare', 'module-start', 'session-stop', 'module-stop', 'release']);
});
test('failed browser close is retained for retry without repeating successful module cleanup', async (t) => {
  const f = await fixture(t, { stopFailsOnce: true });
  await f.start();
  await assert.rejects(() => f.runtime.stop('instance', 'disable'), /module stop failed/);
  assert.equal(f.runtime.actions('instance'), undefined);
  await f.runtime.stop('instance', 'retry');
  assert.deepEqual(f.events, [
    'prepare',
    'module-start',
    'publish',
    'session-stop',
    'module-stop',
    'release',
    'session-stop',
  ]);
});
