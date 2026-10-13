import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.ts';
import { createPluginSourceFactsHost } from '../src/domains/plugin/host-surface/plugin-source-facts-host.ts';

const sourceId = '0000000000001000-000001-00000001';

function fixture(generic = false) {
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: sourceId,
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'astra',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const entry = {
    id: 'entry',
    threadId: 'thread',
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'public input',
    messageId: sourceId,
    mergedMessageIds: [],
    targetCats: ['astra'],
    allTargetCats: ['astra'],
    intent: 'execute',
    autoExecute: true,
    status: 'queued',
    priority: 'normal',
    createdAt: 1000,
    ...(generic ? {} : { pluginPublicInvocation: carrier }),
  };
  const store = new MessageStore();
  store.append({
    reservedId: sourceId,
    threadId: 'thread',
    userId: 'owner',
    catId: null,
    content: entry.content,
    source: { connector: 'fixture' },
    mentions: ['astra'],
    timestamp: 1000,
    deliveryStatus: 'queued',
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 } },
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  let writes = 0;
  const port = {
    getById: async (id) => structuredClone(store.getById(id)),
    transitionQueueCustody: async (id, input) => {
      writes++;
      return store.transitionQueueCustody(id, input);
    },
  };
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: port, now: () => 2000 });
  const bind = (input = {}) => {
    if (generic) {
      Object.assign(entry, {
        status: 'processing',
        processingStartedAt: 2000,
        queuedAwakenedInvocationIdByCatId: { astra: 'child-1' },
        queuedAwakenedAtByCatId: { astra: 2000 },
      });
      return coordinator.persistEntry(entry);
    }
    assert.equal(
      typeof coordinator.bindPublicInvocationChild,
      'function',
      'missing atomic public child custody binding',
    );
    return coordinator.bindPublicInvocationChild({ entry, invocationId: 'child-1', ...input });
  };
  const host = createPluginSourceFactsHost({
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: port,
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner', participants: ['astra'] }) },
    assertCurrent: async () => {},
  });
  const native = (overrides = {}) =>
    withPluginCallContext(
      'instance',
      {
        userId: 'owner',
        threadId: 'thread',
        catId: 'astra',
        invocationId: 'child-1',
        originTriggerMessageId: sourceId,
        assertCurrent: async () => {},
        assertInvocationCurrent: async () => {},
        ...overrides,
      },
      () => host.nativeContext.current(),
    );
  return { entry, store, port, coordinator, bind, host, native, writes: () => writes };
}

test('native context reads the queued origin bound to its authenticated running child', async () => {
  const f = fixture();
  assert.equal((await f.bind()).kind, 'bound');
  const before = structuredClone(f.store.getById(sourceId));
  const value = await f.native();
  assert.equal(value.source.id, sourceId);
  assert.equal(value.invocationId, 'child-1');
  assert.equal(value.source.content, 'public input');
  assert.equal(value.source.queueCustody, undefined);
  assert.deepEqual(f.store.getById(sourceId), before);
});

test('queued source remains inaccessible without an authenticated child', async () => {
  const f = fixture();
  await assert.rejects(() => f.host.sourceFacts.read({ messageRef: `message:${sourceId}` }));
  await assert.rejects(() => f.native());
  assert.equal((await f.bind()).kind, 'bound');
  await assert.rejects(() =>
    withPluginOwnerRequest(
      {
        pluginId: 'plugin',
        contributionId: 'owner',
        userId: 'owner',
        operation: 'read',
        signal: new AbortController().signal,
      },
      () =>
        withPluginOwnerWebhook(
          'plugin',
          'owner',
          'instance',
          false,
          () => {},
          () => f.host.sourceFacts.read({ messageRef: `message:${sourceId}` }),
        ),
    ),
  );
});

test('queued source never substitutes another child, cat or origin', async () => {
  const f = fixture();
  assert.equal((await f.bind()).kind, 'bound');
  for (const override of [
    { invocationId: 'foreign' },
    { catId: 'foreign' },
    { originTriggerMessageId: 'foreign' },
    { assertInvocationCurrent: undefined },
  ]) {
    await assert.rejects(() => f.native(override));
  }
});

test('queued source rejects terminal or changed custody while reading', async () => {
  for (const change of [
    (message) => {
      message.queueCustody.status = 'terminal';
    },
    (message) => {
      message.queueCustody.awakenedInvocationIdByCatId.astra = 'foreign';
    },
    (message) => {
      delete message.queueCustody.pluginPublicInvocation;
    },
    (message) => {
      message.extra.pluginMessage.revision++;
    },
    (message) => {
      message.recall = { recalledAt: 1 };
    },
  ]) {
    const f = fixture();
    assert.equal((await f.bind()).kind, 'bound');
    const get = f.port.getById;
    let reads = 0;
    f.port.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(() => f.native());
    assert.ok(reads >= 2, 'the first read must reach the valid queued source');
  }
});

test('ordinary send wake queued source is readable by its exact awakened native child without a public carrier', async () => {
  const f = fixture(true);
  await f.bind();
  const before = structuredClone(f.store.getById(sourceId));
  assert.equal(before.queueCustody.pluginPublicInvocation, undefined);
  const value = await f.native();
  assert.equal(value.source.id, sourceId);
  assert.equal(value.invocationId, 'child-1');
  assert.deepEqual(f.store.getById(sourceId), before);
});

test('ordinary queued wake still rejects unbound, foreign and retired callers', async () => {
  const f = fixture(true);
  await assert.rejects(() => f.native());
  await f.bind();
  assert.equal((await f.native()).source.id, sourceId);
  for (const override of [
    { invocationId: 'other' },
    { catId: 'other' },
    { userId: 'other' },
    { originTriggerMessageId: 'other' },
    { assertInvocationCurrent: undefined },
  ]) {
    await assert.rejects(() => f.native(override));
  }
  const get = f.port.getById;
  f.port.getById = async (id) => {
    const m = await get(id);
    m.queueCustody.status = 'terminal';
    return m;
  };
  await assert.rejects(() => f.native());
});

test('ordinary queued wake rejects custody replacement or revocation across source reads', async () => {
  for (const change of [
    (m) => {
      m.queueCustody.entryId = 'replacement';
    },
    (m) => {
      m.queueCustody.awakenedInvocationIdByCatId.astra = 'replacement';
    },
    (m) => {
      m.extra.pluginMessage.instanceId = 'other';
    },
    (m) => {
      m.recall = { recalledAt: 1 };
    },
  ]) {
    const f = fixture(true);
    await f.bind();
    assert.equal((await f.native()).source.id, sourceId);
    const get = f.port.getById;
    let reads = 0;
    f.port.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(() => f.native());
    assert.ok(reads >= 2);
  }
});
