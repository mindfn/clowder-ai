import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
  OfficialPluginPackageInstaller,
} from '../dist/domains/plugin/index.js';

test('official Collective Connector installs its verified bundled archive without registry fetch', async (t) => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'collective-connector');
  assert.ok(entry, 'Collective Connector must be discoverable in the official catalog');
  assert.equal(entry.distribution, 'bundled');

  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_collective_connector',
    now: () => 20_000,
  });
  const packagesRoot = await mkdtemp(join(tmpdir(), 'collective-bundled-plugin-'));
  t.after(() => rm(packagesRoot, { recursive: true }));
  const registryFetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('bundled package must not use registry transport');
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory,
    packagesRoot,
    catalog: [entry],
  });

  const installed = await installer.install(entry.catalogId, {
    version: entry.version,
    packageDigest: entry.packageDigest,
  });
  assert.deepEqual(installed, {
    pluginInstanceId: 'pi_collective_connector',
    packageDigest: entry.packageDigest,
    grantRevision: 1,
  });
  assert.equal(registryFetch.mock.callCount(), 0);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.packages[0].manifest.runtime.transport, 'builtin');
  assert.equal(snapshot.packages[0].pluginId, 'official.collective-connector');
  assert.deepEqual(snapshot.grants[0].effectiveGrants, []);
});
