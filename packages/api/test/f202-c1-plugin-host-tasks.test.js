import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label) {
  const root = await mkdtemp(join(tmpdir(), label));
  roots.push(root);
  return root;
}

async function writeTaskFixture() {
  const root = await tempRoot('cat-cafe-f202-task-package-');
  const manifest = {
    pluginId: 'dev.clowder.task-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Task fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
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
      "            'fixture.tasks': async ({ operation, ...input }) => {",
      "              if (operation === 'create') return host.tasks.create(input);",
      "              if (operation === 'get') return host.tasks.get(input.taskId);",
      "              if (operation === 'list') return host.tasks.listByThread(input.threadId);",
      '              return host.tasks.update(input.taskId, input.patch);',
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

test('module plugins create, read, and update ordinary tasks through the Host task store', async () => {
  const projectRoot = await tempRoot('cat-cafe-f202-task-project-');
  const taskStore = new TaskStore();
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    taskStore,
    contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    catalogManifests: [],
  });
  const installed = await composition.manager.install({
    source: { kind: 'local-directory', path: await writeTaskFixture() },
  });
  const detail = (await composition.manager.get(installed.pluginId)).plugin;
  await composition.manager.setEnabled(installed.pluginId, {
    enabled: true,
    expectedRevision: detail.lifecycleRevision,
  });
  const invoke = (input) => runtime.supervisor.invoke(installed.pluginInstanceId, 'fixture.tasks', input);

  const created = await invoke({
    operation: 'create',
    threadId: 'thread-plugin-task',
    title: 'Inspect a migrated notification',
    why: 'Created by an installed plugin through the ordinary task store',
    kind: 'work',
  });
  assert.equal(created.threadId, 'thread-plugin-task');
  assert.equal(created.createdBy, 'system', 'the Host, not package code, owns the persisted task principal');
  assert.deepEqual(await invoke({ operation: 'get', taskId: created.id }), created);
  assert.deepEqual(await invoke({ operation: 'list', threadId: 'thread-plugin-task' }), [created]);

  const updated = await invoke({ operation: 'update', taskId: created.id, patch: { status: 'doing' } });
  assert.equal(updated.status, 'doing');
  assert.equal((await taskStore.listByThread('thread-plugin-task'))[0]?.status, 'doing');
});
