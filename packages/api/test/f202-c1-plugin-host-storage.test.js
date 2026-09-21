import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeStorageRedis {
  hashes = new Map();
  ttlCommands = [];

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async eval(_script, _keyCount, key, field, expectedRevision, value) {
    const hash = this.hashes.get(key) ?? new Map();
    const currentRaw = hash.get(field);
    const current = currentRaw === undefined ? undefined : JSON.parse(currentRaw);
    if (expectedRevision !== '*') {
      const expected = expectedRevision === '' ? null : Number(expectedRevision);
      const actual = current?.revision ?? null;
      if (actual !== expected) return 0;
    }
    const revision = (current?.revision ?? 0) + 1;
    hash.set(field, JSON.stringify({ revision, value: JSON.parse(value) }));
    this.hashes.set(key, hash);
    return revision;
  }

  async expire(...args) {
    this.ttlCommands.push(['expire', ...args]);
    return 1;
  }

  async pexpire(...args) {
    this.ttlCommands.push(['pexpire', ...args]);
    return 1;
  }
}

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeStorageFixture(pluginId, capabilities = ['plugin.state.get', 'plugin.state.set']) {
  const root = await tempRoot('cat-cafe-f202-storage-package-');
  const manifest = {
    pluginId,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: `Storage fixture ${pluginId}`,
    features: [
      {
        id: 'main',
        name: 'Main',
        resources: [],
        capabilities,
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  await writeFile(
    join(root, 'dist/plugin.js'),
    [
      'export default {',
      '  create() {',
      '    return {',
      '      start(host) {',
      '        return {',
      '          actions: {',
      "            'fixture.storage': async ({ operation, key, value, expectedRevision }) => {",
      "              if (operation === 'get') return host.storage.get(key);",
      "              if (operation === 'list') return host.storage.list();",
      "              if (operation === 'set') return host.storage.set(key, value);",
      '              return host.storage.compareAndSet(key, expectedRevision, value);',
      '            },',
      '          },',
      '          stop() {},',
      '        };',
      '      },',
      '    };',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

test('module plugins receive isolated persistent storage with revision-fenced compare-and-set', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-storage-project-');
  const redis = new FakeStorageRedis();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    redis,
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: (manifest) => manifest.features.flatMap((feature) => feature.capabilities),
  });
  const first = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-first') },
  });
  const second = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-second') },
  });
  for (const installed of [first, second]) {
    const detail = (await composition.manager.get(installed.pluginId)).plugin;
    await composition.manager.setEnabled(installed.pluginId, {
      enabled: true,
      expectedRevision: detail.lifecycleRevision,
    });
  }

  const invoke = (pluginInstanceId, input) => runtime.supervisor.invoke(pluginInstanceId, 'fixture.storage', input);
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'set', key: 'cursor', value: { page: 1 } }), {
    revision: 1,
  });
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'get', key: 'cursor' }), {
    revision: 1,
    value: { page: 1 },
  });
  assert.equal(await invoke(second.pluginInstanceId, { operation: 'get', key: 'cursor' }), undefined);
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'compareAndSet',
      key: 'cursor',
      expectedRevision: 0,
      value: { page: 2 },
    }),
    { applied: false },
  );
  assert.deepEqual(
    await invoke(first.pluginInstanceId, {
      operation: 'compareAndSet',
      key: 'cursor',
      expectedRevision: 1,
      value: { page: 2 },
    }),
    { applied: true, revision: 2 },
  );
  assert.deepEqual(await invoke(first.pluginInstanceId, { operation: 'list' }), {
    cursor: { revision: 2, value: { page: 2 } },
  });
  assert.deepEqual(redis.ttlCommands, [], 'plugin state is persistent by default and must never gain an implicit TTL');
});

test('module plugin storage fails closed when the package lacks the matching grant', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-storage-grant-project-');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    redis: new FakeStorageRedis(),
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
    localGrantPolicy: () => [],
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeStorageFixture('dev.clowder.storage-ungranted', []) },
  });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });

  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.storage', {
      operation: 'get',
      key: 'cursor',
    }),
    /lacks plugin\.state\.get/,
  );
  await assert.rejects(
    runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.storage', {
      operation: 'set',
      key: 'cursor',
      value: 1,
    }),
    /lacks plugin\.state\.set/,
  );
});
