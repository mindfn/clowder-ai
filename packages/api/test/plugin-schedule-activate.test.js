// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PluginResourceActivator } from '../dist/domains/plugin/PluginResourceActivator.js';
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';
import { rehydrateEnabledPluginSchedules } from '../dist/domains/plugin/PluginResourceActivator.js';

// ─── Test helpers ──────────────────────────────────────────────────

function makeMinimalManifest(overrides = {}) {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    builtin: false,
    config: [],
    resources: [],
    ...overrides,
  };
}

function makeScheduleResource(overrides = {}) {
  return {
    type: 'schedule',
    factoryId: 'test.poller',
    name: 'my-poller',
    ...overrides,
  };
}

function makeCapabilitiesStore() {
  /** @type {import('@cat-cafe/shared').CapabilitiesConfig | null} */
  let config = null;
  return {
    get() { return config; },
    async read() { return config; },
    async write(/** @type {import('@cat-cafe/shared').CapabilitiesConfig} */ c) { config = structuredClone(c); },
  };
}

function makeTaskRunner() {
  /** @type {Array<{id: string}>} */
  const registered = [];
  /** @type {string[]} */
  const unregistered = [];
  return {
    registered,
    unregistered,
    registerDynamic(/** @type {any} */ task, /** @type {string} */ _defId) {
      registered.push(task);
    },
    unregister(/** @type {string} */ taskId) {
      unregistered.push(taskId);
      return true;
    },
    register(/** @type {any} */ task) {
      registered.push(task);
    },
  };
}

function makeStubFactory(factoryId = 'test.poller') {
  return {
    factoryId,
    createTaskSpec(/** @type {string} */ instanceId, /** @type {any} */ _deps) {
      return /** @type {any} */ ({
        id: instanceId,
        profile: 'poller',
        trigger: { type: 'interval', ms: 60_000 },
        admission: { gate: async () => ({ run: false, reason: 'stub' }) },
        run: { overlap: 'skip', timeoutMs: 30_000, execute: async () => {} },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'drop' },
        enabled: () => true,
      });
    },
  };
}

function makeLimbRegistry() {
  return { register: async () => {}, deregister: () => {} };
}

function makeActivator(deps = {}) {
  const capStore = deps.capStore ?? makeCapabilitiesStore();
  const taskRunner = deps.taskRunner ?? makeTaskRunner();
  const scheduleFactoryRegistry = deps.scheduleFactoryRegistry ?? new ScheduleFactoryRegistry();
  const scheduleFactoryDeps = { log: { info: () => {}, error: () => {} } };

  const activator = new PluginResourceActivator({
    resolveProjectRoot: () => '/tmp/project',
    pluginsDir: '/tmp/plugins',
    limbRegistry: makeLimbRegistry(),
    readCapabilities: () => capStore.read(),
    writeCapabilities: (c) => capStore.write(c),
    withCapabilityLock: async (fn) => fn(),
    scheduleFactoryRegistry,
    taskRunner,
    scheduleFactoryDeps,
    ...deps,
  });

  return { activator, capStore, taskRunner, scheduleFactoryRegistry };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('PluginResourceActivator — schedule resources', () => {
  it('activateSchedule registers task in TaskRunner + writes capability entry', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.resources.length, 1);
    assert.strictEqual(result.resources[0].ok, true);

    // TaskRunner should have received the task
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.registered[0].id, 'plugin-test-plugin-my-poller');

    // Capability entry should be written
    const config = capStore.get();
    assert.ok(config);
    const entry = config.capabilities.find(c => c.type === 'schedule');
    assert.ok(entry);
    assert.strictEqual(entry.enabled, true);
    assert.strictEqual(entry.pluginId, 'test-plugin');
    assert.strictEqual(entry.scheduleTaskId, 'plugin-test-plugin-my-poller');
  });

  it('deactivateSchedule unregisters task + removes capability entry', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });

    // First enable
    await activator.enablePlugin(manifest);
    assert.strictEqual(taskRunner.registered.length, 1);

    // Then disable
    const result = await activator.disablePlugin(manifest);
    assert.strictEqual(result.status, 'success');

    // TaskRunner.unregister should have been called
    assert.strictEqual(taskRunner.unregistered.length, 1);
    assert.strictEqual(taskRunner.unregistered[0], 'plugin-test-plugin-my-poller');

    // Capability entry should be removed
    const config = capStore.get();
    assert.ok(config);
    const scheduleEntries = config.capabilities.filter(c => c.type === 'schedule');
    assert.strictEqual(scheduleEntries.length, 0);
  });

  it('activateSchedule throws when factoryId not found in registry', async () => {
    // Empty registry — no factories registered
    const { activator } = makeActivator();

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: 'nonexistent.factory' })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('nonexistent.factory'));
  });

  it('activateSchedule throws when factoryId is missing', async () => {
    const { activator } = makeActivator();

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ factoryId: undefined })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('factoryId'));
  });

  it('activateSchedule throws when name is missing', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource({ name: undefined })],
    });
    const result = await activator.enablePlugin(manifest);

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.resources[0].ok, false);
    assert.ok(result.resources[0].error?.includes('name'));
  });

  it('activate then deactivate → task not running, capability gone', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [makeScheduleResource()],
    });

    // Full lifecycle
    await activator.enablePlugin(manifest);
    const configAfterEnable = capStore.get();
    assert.strictEqual(configAfterEnable?.capabilities.length, 1);

    await activator.disablePlugin(manifest);
    const configAfterDisable = capStore.get();
    assert.strictEqual(configAfterDisable?.capabilities.length, 0);

    // Both register and unregister were called
    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.unregistered.length, 1);
  });

  it('handles multiple schedule resources in one plugin', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    registry.register(makeStubFactory('test.checker'));
    const { activator, capStore, taskRunner } = makeActivator({ scheduleFactoryRegistry: registry });

    const manifest = makeMinimalManifest({
      resources: [
        makeScheduleResource({ factoryId: 'test.poller', name: 'poller' }),
        makeScheduleResource({ factoryId: 'test.checker', name: 'checker' }),
      ],
    });

    const result = await activator.enablePlugin(manifest);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(taskRunner.registered.length, 2);
    assert.strictEqual(capStore.get()?.capabilities.length, 2);
  });
});

describe('rehydrateEnabledPluginSchedules', () => {
  it('rehydrates enabled schedule capabilities from config', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [{
        id: 'plugin:test-plugin:my-poller',
        type: 'schedule',
        enabled: true,
        source: 'cat-cafe',
        pluginId: 'test-plugin',
        scheduleTaskId: 'plugin-test-plugin-my-poller',
      }],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ pluginId) {
        if (pluginId === 'test-plugin') {
          return makeMinimalManifest({
            resources: [makeScheduleResource()],
          });
        }
        return undefined;
      },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {} } },
      log: { info: () => {}, warn: () => {} },
    });

    assert.strictEqual(taskRunner.registered.length, 1);
    assert.strictEqual(taskRunner.registered[0].id, 'plugin-test-plugin-my-poller');
  });

  it('skips disabled schedule capabilities', async () => {
    const registry = new ScheduleFactoryRegistry();
    registry.register(makeStubFactory('test.poller'));
    const taskRunner = makeTaskRunner();

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [{
        id: 'plugin:test-plugin:my-poller',
        type: 'schedule',
        enabled: false,  // disabled
        source: 'cat-cafe',
        pluginId: 'test-plugin',
        scheduleTaskId: 'plugin-test-plugin-my-poller',
      }],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ _id) { return makeMinimalManifest({ resources: [makeScheduleResource()] }); },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {} } },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
  });

  it('skips when factory not registered (warns)', async () => {
    const registry = new ScheduleFactoryRegistry(); // empty — no factories
    const taskRunner = makeTaskRunner();
    const warnings = [];

    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const capabilities = {
      version: 1,
      capabilities: [{
        id: 'plugin:test-plugin:my-poller',
        type: 'schedule',
        enabled: true,
        source: 'cat-cafe',
        pluginId: 'test-plugin',
        scheduleTaskId: 'plugin-test-plugin-my-poller',
      }],
    };

    const pluginRegistry = {
      getManifest(/** @type {string} */ _id) { return makeMinimalManifest({ resources: [makeScheduleResource()] }); },
    };

    await rehydrateEnabledPluginSchedules({
      capabilities,
      pluginRegistry,
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {} } },
      log: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
    assert.ok(warnings.some(w => w.includes('test.poller')));
  });

  it('handles null capabilities gracefully', async () => {
    const registry = new ScheduleFactoryRegistry();
    const taskRunner = makeTaskRunner();

    await rehydrateEnabledPluginSchedules({
      capabilities: null,
      pluginRegistry: { getManifest: () => undefined },
      scheduleFactoryRegistry: registry,
      taskRunner,
      scheduleFactoryDeps: { log: { info: () => {}, error: () => {} } },
    });

    assert.strictEqual(taskRunner.registered.length, 0);
  });
});
