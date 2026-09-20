import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from '../dist/domains/plugin/builtin-runtime/module-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/runtime-carrier.js';

/**
 * F202 Train C1 — §8.6 steps 1 / 2 / 5 of the carrier-neutral adapter
 * (docs/plans/2026-09-19-f202-train-c1-migration-plan.md).
 *
 * Step 1: take the DEFAULT export of the module at `runtime.entrypoint`, assert `create`.
 * Step 2: the Host passes the manifest IT admitted into `create()`, never the package's
 *         self-reported copy.
 * Step 5: every teardown path reaches the runtime's disposal seam.
 *
 * These cases load a REAL file from disk through a REAL dynamic import. A recording
 * double would prove the test harness works, not that the Host can load a package.
 */

const MODULE_LOG = '__f202C1ModuleCarrierLog';

function manifest(overrides = {}) {
  return {
    pluginId: 'dev.clowder.module-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'Module Fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    ...overrides,
  };
}

/** A real package tree with a real ESM entrypoint that records what the Host did to it. */
async function writePackage(source) {
  const rootDir = await mkdtemp(join(tmpdir(), 'f202-c1-module-'));
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(join(rootDir, 'dist/plugin.js'), source, 'utf8');
  return rootDir;
}

const wellFormedModule = `
const log = (globalThis[${JSON.stringify(MODULE_LOG)}] ??= []);
export default {
  create(hostManifest) {
    log.push({ call: 'create', pluginId: hostManifest?.pluginId, version: hostManifest?.version });
    return { manifest: hostManifest, features: [] };
  },
};
`;

const noCreateModule = `
export default { activate() {} };
`;

const throwingModule = `
export default {
  create() {
    throw new Error('package blew up while defining itself');
  },
};
`;

function inventoryOf(records) {
  const packages = records.map((record, index) => ({
    packageDigest: `digest-${index}`,
    pluginId: record.manifest.pluginId,
    version: record.manifest.version,
    contractVersion: record.manifest.contractVersion,
    manifest: record.manifest,
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
    live,
    snapshot: async () => ({ packages, instances: [...live.values()], grants: [] }),
    transaction: async (apply) =>
      apply({
        instances: {
          get: (id) => live.get(id),
          put: (value) => live.set(value.pluginInstanceId, value),
        },
      }),
  };
}

/**
 * @param {ReadonlyArray<{manifest: object, rootDir: string, locatedManifest?: object}>} records
 */
function hostOf(records) {
  const inventory = inventoryOf(records);
  const released = [];
  const packages = {
    resolveInstalledPackage: async (packageDigest) => {
      const index = Number(packageDigest.replace('digest-', ''));
      const record = records[index];
      if (!record) throw new Error(`no fixture package for ${packageDigest}`);
      return {
        rootDir: record.rootDir,
        manifest: record.locatedManifest ?? record.manifest,
        verifyIntegrity: record.verifyIntegrity ?? (async () => {}),
        release: async () => {
          released.push(packageDigest);
        },
      };
    },
  };
  const moduleRuntime = new ModulePluginRuntime({ packages });
  const router = new PluginRuntimeCarrierRouter(inventory);
  router.register(new BundledPluginRuntimeCarrier({ inventory, runtimes: [moduleRuntime], now: () => 5_000 }));
  return { inventory, router, released, moduleRuntime };
}

function moduleLog() {
  return globalThis[MODULE_LOG] ?? [];
}

function resetModuleLog() {
  globalThis[MODULE_LOG] = [];
}

test('takes the default export of runtime.entrypoint and runs it in the Host process', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');

  assert.deepEqual(
    moduleLog().map((entry) => entry.call),
    ['create'],
    'the Host must call create() on the module default export',
  );
  assert.equal(host.inventory.live.get('instance-0').runtimeState, 'healthy');
  // The Host holds the instance create() returned — the thing per-feature activation
  // will consume once the SDK publishes it (§8.8 step 3).
  assert.equal(host.moduleRuntime.definedPlugin('instance-0').manifest.pluginId, 'dev.clowder.module-fixture');

  await host.router.stop('instance-0', 'host_stop');
  assert.equal(host.moduleRuntime.definedPlugin('instance-0'), undefined, 'teardown must let the instance go');
});

// What this pins: the Host actually hands its admitted record to `create()`. The other
// half of step 2 — that the package's own copy can never differ — is enforced by the
// authority and pinned by the drift case below, not here.
test('hands the record the Host admitted to create()', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await host.router.start('instance-0');

  const created = moduleLog().find((entry) => entry.call === 'create');
  assert.equal(created.pluginId, 'dev.clowder.module-fixture');
  assert.equal(created.version, '0.1.0');
});

test('refuses a package whose located manifest drifts from the admitted record', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  const host = hostOf([{ manifest: manifest(), rootDir, locatedManifest: manifest({ version: '9.9.9' }) }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'PACKAGE_AUTHORITY_MISMATCH');
    return true;
  });
  assert.equal(moduleLog().length, 0, 'a drifting package must never be imported');
});

test('refuses an entrypoint that escapes the admitted package root', async () => {
  resetModuleLog();
  // The escape target is a REAL, perfectly loadable module outside the package. If the
  // Host ever resolved entrypoints on its own instead of going through the shared
  // authority, this would import and run — so containment is the only thing that can
  // refuse it, and "the import happened to fail" cannot be mistaken for a refusal.
  const neighbour = await writePackage(wellFormedModule);
  const rootDir = await writePackage(wellFormedModule);
  const escaping = manifest({
    runtime: { transport: 'builtin', entrypoint: `../${basename(neighbour)}/dist/plugin.js` },
  });
  const host = hostOf([{ manifest: escaping, rootDir }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'INVALID_ENTRYPOINT');
    assert.match(error.message, /escapes the admitted package root/);
    return true;
  });
  assert.equal(moduleLog().length, 0, 'an escaping entrypoint must never be imported');
});

test('reports a default export without create() as a package failure the owner can see', async () => {
  resetModuleLog();
  const rootDir = await writePackage(noCreateModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'), (error) => {
    assert.equal(error.code, 'INVALID_ENTRYPOINT');
    return true;
  });
  const instance = host.inventory.live.get('instance-0');
  assert.equal(instance.runtimeState, 'stopped');
  assert.equal(
    instance.lastRuntimeError?.code,
    'UNEXPECTED_RUNTIME_FAILURE',
    'a malformed package must leave the owner a reason, not a silent stop',
  );
});

test('reports a module that throws while defining itself as a package failure', async () => {
  resetModuleLog();
  const rootDir = await writePackage(throwingModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'));
  assert.equal(host.inventory.live.get('instance-0').lastRuntimeError?.code, 'UNEXPECTED_RUNTIME_FAILURE');
});

test('every teardown path releases the module instance so a restart re-creates it', async () => {
  const paths = [
    { name: 'host stop', activationState: 'enabled', run: (host) => host.router.stop('instance-0', 'host_stop') },
    {
      name: 'owner disable',
      activationState: 'disabled',
      run: (host) => host.router.stop('instance-0', 'owner_disabled'),
    },
    { name: 'uninstall', activationState: 'disabling', run: (host) => host.router.stop('instance-0', 'uninstall') },
    { name: 'host shutdown', activationState: 'enabled', run: (host) => host.router.stopAll('host_shutdown') },
  ];

  for (const path of paths) {
    resetModuleLog();
    const rootDir = await writePackage(wellFormedModule);
    const host = hostOf([{ manifest: manifest(), rootDir }]);

    await host.router.start('instance-0');
    await host.inventory.transaction((transaction) => {
      const instance = transaction.instances.get('instance-0');
      transaction.instances.put({ ...instance, activationState: path.activationState, updatedAt: 6_000 });
    });

    await path.run(host);
    assert.equal(host.released.length, 1, `${path.name} must release the located package`);

    await host.inventory.transaction((transaction) => {
      const instance = transaction.instances.get('instance-0');
      transaction.instances.put({ ...instance, activationState: 'enabled', updatedAt: 7_000 });
    });
    await host.router.start('instance-0');
    assert.equal(
      moduleLog().filter((entry) => entry.call === 'create').length,
      2,
      `${path.name} must leave no stale module instance behind`,
    );
  }
});

test('a failed start releases the module instance before it rolls back', async () => {
  resetModuleLog();
  const rootDir = await writePackage(throwingModule);
  const host = hostOf([{ manifest: manifest(), rootDir }]);

  await assert.rejects(host.router.start('instance-0'));

  assert.equal(host.released.length, 1, 'start-failure rollback must reach the same disposal seam');
});

test('a staged tree that changed after admission is never imported into the Host', async () => {
  resetModuleLog();
  const rootDir = await writePackage(wellFormedModule);
  let integrityCalls = 0;
  const host = hostOf([
    {
      manifest: manifest(),
      rootDir,
      verifyIntegrity: async () => {
        integrityCalls += 1;
        throw new Error('launchable package bytes changed after verified staging');
      },
    },
  ]);

  await assert.rejects(host.router.start('instance-0'), /bytes changed after verified staging/);

  assert.equal(integrityCalls, 1, 'the module carrier verifies admitted bytes exactly once');
  assert.deepEqual(moduleLog(), [], 'a tree that failed integrity must never reach dynamic import');
});
