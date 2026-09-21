import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let createPluginThreadHost;
let ThreadStore;
let MemoryConnectorThreadBindingStore;

const OWNER = 'owner-1';

beforeEach(async () => {
  ({ createPluginThreadHost } = await import('../dist/domains/plugin/plugin-thread-host.js'));
  ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  ({ MemoryConnectorThreadBindingStore } = await import(
    '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js'
  ));
});

function hostOf(options = {}) {
  const threadStore = options.threadStore ?? new ThreadStore();
  const bindingStore = options.bindingStore ?? new MemoryConnectorThreadBindingStore();
  const host = createPluginThreadHost({
    pluginId: options.pluginId ?? 'dev.clowder.fixture',
    pluginInstanceId: options.pluginInstanceId ?? 'instance-1',
    ownerUserId: OWNER,
    effectiveGrants: options.effectiveGrants ?? ['thread.listMetadata', 'thread.readContent'],
    threadStore,
    bindingStore,
    systemThreadTitle: options.systemThreadTitle ?? 'Fixture',
  });
  return { host, threadStore, bindingStore };
}

describe('F202 C1 — plugin Host thread surface', () => {
  test('concurrent ensureByKey converges on one persistent plugin-owned thread', async () => {
    const { host, threadStore } = hostOf();

    const [first, second] = await Promise.all([
      host.ensureByKey('group-42', { title: 'Group 42' }),
      host.ensureByKey('group-42', { title: 'Group 42' }),
    ]);

    assert.equal(first.id, second.id);
    assert.deepEqual(await host.findByKey('group-42'), first);
    const bindings = await host.listBindings();
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].key, 'group-42');
    assert.equal(bindings[0].threadId, first.id);
    assert.equal(typeof bindings[0].createdAt, 'number');
    assert.deepEqual((await threadStore.get(first.id))?.pluginOwnership, {
      v: 1,
      pluginInstanceId: 'instance-1',
    });
    assert.equal((await threadStore.list(OWNER)).filter((thread) => thread.id === first.id).length, 1);
  });

  test('the same external key is isolated by the Host-bound plugin id', async () => {
    const threadStore = new ThreadStore();
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const first = hostOf({ pluginId: 'dev.clowder.first', pluginInstanceId: 'first-1', threadStore, bindingStore });
    const second = hostOf({ pluginId: 'dev.clowder.second', pluginInstanceId: 'second-1', threadStore, bindingStore });

    const firstThread = await first.host.ensureByKey('same-key', { title: 'First' });
    const secondThread = await second.host.ensureByKey('same-key', { title: 'Second' });

    assert.notEqual(firstThread.id, secondThread.id);
    assert.equal((await first.host.findByKey('same-key'))?.id, firstThread.id);
    assert.equal((await second.host.findByKey('same-key'))?.id, secondThread.id);
  });

  test('the fixed system thread is stable and plugin-owned', async () => {
    const { host, threadStore } = hostOf();

    const first = await host.ensureSystemThread();
    const second = await host.ensureSystemThread();

    assert.equal(first.id, second.id);
    assert.deepEqual((await threadStore.get(first.id))?.pluginOwnership, {
      v: 1,
      pluginInstanceId: 'instance-1',
    });
  });

  test('reads are grant-gated and one plugin cannot mutate another plugin-owned thread', async () => {
    const threadStore = new ThreadStore();
    const bindingStore = new MemoryConnectorThreadBindingStore();
    const owner = hostOf({ pluginId: 'dev.clowder.owner', pluginInstanceId: 'owner-1', threadStore, bindingStore });
    const stranger = hostOf({
      pluginId: 'dev.clowder.stranger',
      pluginInstanceId: 'stranger-1',
      threadStore,
      bindingStore,
    });
    const noRead = hostOf({
      pluginId: 'dev.clowder.no-read',
      pluginInstanceId: 'no-read-1',
      effectiveGrants: [],
      threadStore,
      bindingStore,
    });
    const thread = await owner.host.create({ title: 'Owned' });

    await assert.rejects(() => stranger.host.update(thread.id, { title: 'Stolen' }), /does not own thread/);
    await assert.rejects(() => noRead.host.get(thread.id), /lacks thread\.readContent/);
    assert.equal((await owner.host.get(thread.id))?.title, 'Owned');
  });

  test('binding an owner thread does not turn it into plugin-owned state', async () => {
    const { host, threadStore } = hostOf();
    const existing = await threadStore.create(OWNER, 'Existing');

    await host.bind('selected-thread', existing.id);

    assert.equal((await host.findByKey('selected-thread'))?.id, existing.id);
    assert.equal((await threadStore.get(existing.id))?.pluginOwnership, undefined);
    assert.equal(await host.unbind('selected-thread'), true);
    assert.equal(await host.findByKey('selected-thread'), null);
  });
});
