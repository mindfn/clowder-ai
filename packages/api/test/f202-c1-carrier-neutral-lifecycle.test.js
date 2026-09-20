import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/bundled-runtime-carrier.js';
import { CollectiveConnectorBuiltinRuntime } from '../dist/domains/plugin/builtin-runtime/collective-connector-runtime.js';
import { COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST } from '../dist/domains/plugin/official-catalog.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/runtime-carrier.js';

/**
 * F202 Train C1 — clause 1 / 2 / 6 of the terminal acceptance contract
 * (docs/plans/2026-09-19-f202-train-c1-migration-plan.md §8.1).
 *
 * Clause 2 says every installed instance takes ONE lifecycle path and the carrier is
 * selected from the package manifest, never by the caller. Clause 6 says no Core rule
 * may branch on a specific pluginId. These cases pin both as executable acceptance.
 */

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
    ...overrides,
  };
}

function inventoryOf(...manifests) {
  const packages = manifests.map((value, index) => ({
    packageDigest: `digest-${index}`,
    pluginId: value.pluginId,
    version: value.version,
    contractVersion: value.contractVersion,
    manifest: value,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 0,
    updatedAt: 0,
  }));
  const instances = packages.map((record, index) => ({
    pluginInstanceId: `instance-${index}`,
    pluginId: record.pluginId,
    packageDigest: record.packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'stopped',
    lifecycleRevision: 1,
    installedAt: 0,
    updatedAt: 0,
  }));
  const live = new Map(instances.map((instance) => [instance.pluginInstanceId, instance]));
  return {
    snapshot: async () => ({ packages, instances: [...live.values()], grants: [] }),
    transaction: async (apply) =>
      apply({
        instances: {
          get: (id) => live.get(id),
          put: (record) => live.set(record.pluginInstanceId, record),
        },
      }),
  };
}

function recordingCarrier(name, claims, calls) {
  return {
    claims: (admission) => {
      calls.push(`${name}:claims:${admission.packageRecord.pluginId}`);
      return claims(admission);
    },
    start: async (instanceId) => {
      calls.push(`${name}:start:${instanceId}`);
      return { carrier: name };
    },
    stop: async (instanceId, reason) => {
      calls.push(`${name}:stop:${instanceId}:${reason}`);
    },
    stopAll: async (reason) => {
      calls.push(`${name}:stopAll:${reason}`);
    },
  };
}

test('routes every instance through one selection point, resolved from its own manifest', async () => {
  const calls = [];
  const inventory = inventoryOf(
    manifest({ pluginId: 'dev.clowder.bundled' }),
    manifest({ pluginId: 'dev.clowder.external', runtime: { transport: 'stdio', entrypoint: 'dist/main.js' } }),
  );
  const router = new PluginRuntimeCarrierRouter(inventory);
  router.register(
    recordingCarrier('bundled', ({ packageRecord }) => packageRecord.manifest.runtime.transport === 'builtin', calls),
  );
  router.register(
    recordingCarrier('external', ({ packageRecord }) => packageRecord.manifest.runtime.transport !== 'builtin', calls),
  );

  assert.deepEqual(await router.start('instance-0'), { carrier: 'bundled' });
  assert.deepEqual(await router.start('instance-1'), { carrier: 'external' });
  await router.stop('instance-1', 'host_stop');

  assert.deepEqual(calls, [
    'bundled:claims:dev.clowder.bundled',
    'bundled:start:instance-0',
    'bundled:claims:dev.clowder.external',
    'external:claims:dev.clowder.external',
    'external:start:instance-1',
    'bundled:claims:dev.clowder.external',
    'external:claims:dev.clowder.external',
    'external:stop:instance-1:host_stop',
  ]);
});

test('refuses an unclaimed package with one typed runtime error, not a bare host Error', async () => {
  const router = new PluginRuntimeCarrierRouter(inventoryOf(manifest()));
  router.register(
    recordingCarrier('external', ({ packageRecord }) => packageRecord.manifest.runtime.transport !== 'builtin', []),
  );

  await assert.rejects(router.start('instance-0'), (error) => {
    assert.equal(error.name, 'ExternalPluginRuntimeError');
    assert.equal(error.code, 'UNSUPPORTED_TRANSPORT');
    return true;
  });
  await assert.rejects(router.start('instance-missing'), (error) => {
    assert.equal(error.code, 'INSTANCE_NOT_RUNNABLE');
    return true;
  });
});

test('shutdown reaches every registered carrier and surfaces the failure', async () => {
  const calls = [];
  const router = new PluginRuntimeCarrierRouter(inventoryOf(manifest()));
  router.register({
    claims: () => true,
    start: async () => undefined,
    stop: async () => undefined,
    stopAll: async () => {
      calls.push('first');
      throw new Error('first carrier refused to stop');
    },
  });
  router.register(recordingCarrier('second', () => true, calls));

  await assert.rejects(router.stopAll('host_shutdown'), /first carrier refused to stop/);
  assert.deepEqual(calls, ['first', 'second:stopAll:host_shutdown']);
});

test('restart recovery sums carrier recovery and propagates a carrier refusal', async () => {
  const router = new PluginRuntimeCarrierRouter(inventoryOf(manifest()));
  router.register({ ...recordingCarrier('bundled', () => true, []), recoverAfterRestart: async () => 0 });
  router.register({ ...recordingCarrier('external', () => false, []), recoverAfterRestart: async () => 3 });
  assert.equal(await router.recoverAfterRestart(), 3);

  const refusing = new PluginRuntimeCarrierRouter(inventoryOf(manifest()));
  refusing.register({
    ...recordingCarrier('bundled', () => true, []),
    recoverAfterRestart: async () => {
      throw new Error('bundled authority still active');
    },
  });
  await assert.rejects(refusing.recoverAfterRestart(), /bundled authority still active/);
});

test('a bundled runtime claims the package it declares — the router never names one', async () => {
  const started = [];
  const fixtureRuntime = {
    claims: (packageRecord) => packageRecord.manifest.pluginId === 'dev.clowder.bundled-fixture',
    start: async (instanceId) => {
      started.push(instanceId);
    },
    stop: async () => undefined,
  };
  const inventory = inventoryOf(
    manifest({ pluginId: 'dev.clowder.bundled-fixture' }),
    manifest({ pluginId: 'dev.clowder.unimplemented' }),
    manifest({ pluginId: 'dev.clowder.external', runtime: { transport: 'stdio', entrypoint: 'dist/main.js' } }),
  );
  const carrier = new BundledPluginRuntimeCarrier({ inventory, runtimes: [fixtureRuntime] });
  const snapshot = await inventory.snapshot();
  const admissionOf = (index) => ({ instance: snapshot.instances[index], packageRecord: snapshot.packages[index] });

  assert.equal(carrier.claims(admissionOf(0)), true);
  assert.equal(carrier.claims(admissionOf(1)), false, 'an unimplemented builtin package is not this carrier’s');
  assert.equal(carrier.claims(admissionOf(2)), false, 'a stdio package is never carried in Host process');

  await carrier.start('instance-0');
  assert.deepEqual(started, ['instance-0']);
});

test('the Collective Connector runtime claims its own bundled manifest', () => {
  const runtime = new CollectiveConnectorBuiltinRuntime({
    dataDirectory: '/tmp/f202-c1-carrier-neutral-lifecycle',
    verifyAgent: async () => true,
  });
  assert.equal(runtime.claims({ manifest: COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST }), true);
  assert.equal(runtime.claims({ manifest: manifest({ pluginId: 'official.collective-connector-lookalike' }) }), false);
});
