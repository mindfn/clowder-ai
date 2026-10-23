/** Connector installation uses the public SDK without a second Host API permission table. */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

const roots = [];
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const CONNECTOR = [
  'streams.read',
  'message.event.subscribe',
  'messaging.send',
  'plugin.config.read',
  'plugin.state.get',
  'plugin.state.set',
  'secret.read',
  'thread.listMetadata',
  'thread.readContent',
  'thread.write',
];
function collectiveManifest(capabilities = []) {
  const value = manifest('official.collective-connector', capabilities);
  value.runtime.dataDirectory = 'collective';
  value.features[0].contributions = [];
  value.contributions = [];
  return value;
}

test('Collective local directory installation retains its declared data path', async () => {
  const host = await installed(collectiveManifest());
  try {
    assert.deepEqual(host.grants.requestedCapabilities, []);
    assert.deepEqual(host.grants.effectiveGrants, []);
  } finally {
    await host.shutdown();
  }
});

const GITHUB = [
  'schedule.register',
  'plugin.config.read',
  'secret.read',
  'plugin.state.get',
  'plugin.state.set',
  'thread.listMetadata',
  'thread.write',
  'messaging.send',
];

function manifest(pluginId, capabilities = CONNECTOR) {
  return {
    pluginId,
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'W2-6 connector fixture',
    features: [{ id: 'messaging', name: 'Messaging', resources: [], capabilities }],
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
  };
}

// Connector activation reads its thread bindings through the public SDK.
const moduleSource = `
export default {
  create() {
    return {
      async start(host) {
        await host.threads.list();
        return {
          actions: { 'probe.read-task': async () => host.tasks.get({ id: 'task-1' }) },
          async stop() {},
        };
      },
    };
  },
};
`;

/** A production composition with one package installed from disk. */
async function installed(packageManifest, source = moduleSource) {
  const projectRoot = await tempRoot('f202-w2-6-project-');
  const packageRoot = await tempRoot('f202-w2-6-package-');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(packageManifest)}\n`);
  await writeFile(join(packageRoot, 'dist/plugin.js'), source);
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    threadStore: new ThreadStore(),
    threadBindingStore: new MemoryConnectorThreadBindingStore(),
    threadOwnerUserId: 'owner-1',
    contract: { manifestContractRange: '0.1.0', validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const { pluginId, pluginInstanceId } = await composition.manager.install({
    source: { kind: 'local-directory', path: packageRoot },
  });
  const grants = (await runtime.inventoryStore.snapshot()).grants.find(
    (candidate) => candidate.pluginInstanceId === pluginInstanceId,
  );
  const enable = async () => {
    const detail = (await composition.manager.get(pluginId)).plugin;
    return composition.manager.setEnabled(pluginId, { enabled: true, expectedRevision: detail.lifecycleRevision });
  };
  return { runtime, pluginInstanceId, grants, enable, shutdown: () => runtime.shutdown('test_done') };
}

test('production starts installed connectors through the same public SDK', async () => {
  const official = await installed(manifest('official.connector.wecom-bot'));
  assert.deepEqual(official.grants.effectiveGrants, []);
  await official.enable();
  await official.shutdown();

  const unlisted = await installed(manifest('dev.example.unlisted-connector'));
  assert.deepEqual(unlisted.grants.effectiveGrants, []);
  await unlisted.enable();
  await unlisted.shutdown();
});

test('Collective config carrier reads its declared loopback port', async () => {
  const current = collectiveManifest(['plugin.config.read', 'secret.read']);
  current.configuration = [
    { key: 'servicePort', kind: 'string', label: 'Service port', required: false, default: '5813' },
    { key: 'privateToken', kind: 'secret', label: 'Private token', required: false },
  ];
  const host = await installed(
    current,
    `export default {create() {return {async start(host) {
    const port = await host.config.get('servicePort');
    if (port !== '5813') throw new Error('declared service port unavailable');
    return {actions:{'probe.secret': async () => host.secrets.get('privateToken')},async stop(){}};
  }}}};`,
  );
  try {
    await host.enable();
    assert.equal(await host.runtime.supervisor.invoke(host.pluginInstanceId, 'probe.secret', {}), undefined);
  } finally {
    await host.shutdown();
  }
});
