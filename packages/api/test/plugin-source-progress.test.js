import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.ts';
import { createPluginSourceFactsHost } from '../src/domains/plugin/host-surface/plugin-source-facts-host.ts';

function fixture() {
  const store = new MessageStore();
  const custody = createInitialQueuedMessageCustody({
    id: 'entry',
    threadId: 'thread',
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'secret queued body',
    messageId: 'source',
    mergedMessageIds: [],
    targetCats: ['cat'],
    allTargetCats: ['cat'],
    intent: 'execute',
    autoExecute: true,
    status: 'queued',
    priority: 'normal',
    createdAt: 1000,
  });
  const message = store.append({
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    content: 'secret queued body',
    mentions: ['cat'],
    timestamp: 1000,
    deliveryStatus: 'queued',
    queueCustody: custody,
    source: {
      connector: 'neutral',
      meta: { participation: { connectionId: 'connection', eventId: 'event', catId: 'cat' } },
    },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 }, secret: 'private' },
  });
  const messages = { getById: async (id) => structuredClone(store.getById(id)) };
  const threads = { get: async () => ({ id: 'thread', createdBy: 'owner' }) };
  const deps = {
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: messages,
    threadStore: threads,
    assertCurrent: async (caps) => assert.deepEqual(caps, ['thread.readContent']),
  };
  const host = createPluginSourceFactsHost(deps);
  const owner = (operation, userId = 'owner') =>
    withPluginOwnerRequest(
      {
        pluginId: 'neutral',
        contributionId: 'owner',
        userId,
        operation: 'read',
        signal: new AbortController().signal,
      },
      () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, operation),
    );
  const read = () => owner(() => host.sourceFacts.readProgress({ messageRef: `message:${message.id}` }));
  return { store, message, messages, threads, deps, host, owner, read };
}

test('owner reads same-instance queued progress without exposing queued content or acquiring native authority', async () => {
  const f = fixture();
  const value = await f.read();
  assert.deepEqual(value, {
    id: f.message.id,
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    source: f.message.source,
    extra: { pluginMessage: { instanceId: 'instance' } },
    queueCustody: {
      status: 'queued',
      allTargetCats: ['cat'],
      handledByCatIds: [],
      failedByCatIds: [],
      seenByCatIds: [],
    },
  });
  assert.ok(Object.isFrozen(value.queueCustody.allTargetCats));
  await assert.rejects(() => f.owner(() => f.host.sourceFacts.read({ messageRef: `message:${f.message.id}` })));
  await assert.rejects(() => f.owner(() => f.host.nativeContext.current()));
});

test('progress reads retain terminal custody after the real queue delivery transition', async () => {
  const f = fixture();
  const current = f.store.getById(f.message.id).queueCustody;
  const transition = f.store.transitionQueueCustody(f.message.id, {
    expectedRevision: current.revision,
    next: {
      ...current,
      revision: current.revision + 1,
      status: 'terminal',
      pendingTargetCats: [],
      handledByCatIds: ['cat'],
      updatedAt: 2000,
    },
    deliveredAt: 2000,
  });
  assert.equal(transition.kind, 'updated');
  assert.equal(transition.message.deliveryStatus, 'delivered');
  const value = await f.read();
  assert.deepEqual(value.queueCustody.handledByCatIds, ['cat']);
  assert.equal(value.queueCustody.status, 'terminal');
  assert.equal(value.content, undefined);
});

test('real Queue transitions expose started, failed and successful outcome facts without invocation witnesses', async () => {
  for (const stage of ['started', 'failed', 'ended']) {
    const f = fixture();
    const current = f.store.getById(f.message.id).queueCustody;
    const exposure = { targetCatId: 'cat', invocationId: 'private-child', seenAt: 1100 };
    const next = {
      ...current,
      revision: current.revision + 1,
      status: 'processing',
      updatedAt: 2000,
      bodyExposures: [exposure],
      seenByCatIds: ['cat'],
      seenInvocationIdByCatId: { cat: 'private-child' },
    };
    if (stage === 'failed') next.failedByCatIds = ['cat'];
    if (stage === 'ended')
      Object.assign(next, {
        status: 'terminal',
        pendingTargetCats: [],
        handledByCatIds: ['cat'],
        targetOutcomeByCatId: {
          cat: {
            invocationId: 'private-child',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'turn_execution', invocationId: 'private-child' },
            handledAt: 2000,
          },
        },
      });
    const transition = f.store.transitionQueueCustody(f.message.id, {
      expectedRevision: current.revision,
      next,
      ...(stage === 'ended' ? { deliveredAt: 2000 } : {}),
    });
    assert.equal(transition.kind, 'updated');
    const value = await f.read();
    assert.deepEqual(value.queueCustody.bodyExposures, [{ targetCatId: 'cat' }]);
    assert.deepEqual(value.queueCustody.seenByCatIds, ['cat']);
    assert.deepEqual(value.queueCustody.failedByCatIds, stage === 'failed' ? ['cat'] : []);
    assert.deepEqual(
      value.queueCustody.targetOutcomeByCatId,
      stage === 'ended' ? { cat: { handledAt: 2000 } } : undefined,
    );
    assert.ok(!JSON.stringify(value).includes('private-child'));
  }
});

test('progress requires current owner, grant, source, thread and queue owner; native context is insufficient', async () => {
  const f = fixture();
  assert.equal(typeof f.host.sourceFacts.readProgress, 'function');
  await assert.rejects(() => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }));
  await assert.rejects(() =>
    f.owner(() => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }), 'foreign'),
  );
  await assert.rejects(() =>
    withPluginCallContext(
      'instance',
      {
        userId: 'owner',
        threadId: 'thread',
        catId: 'cat',
        invocationId: 'inv',
        originTriggerMessageId: f.message.id,
        assertCurrent: async () => {},
        assertInvocationCurrent: async () => {},
      },
      () => f.host.sourceFacts.readProgress({ messageRef: `message:${f.message.id}` }),
    ),
  );
  const get = f.messages.getById;
  for (const change of [
    (m) => {
      m.userId = 'foreign';
    },
    (m) => {
      m.extra.pluginMessage.instanceId = 'foreign';
    },
    (m) => {
      m.queueCustody.ownerUserId = 'foreign';
    },
    (m) => {
      m.recall = { recalledAt: 1 };
    },
    (m) => {
      m.queueCustody.executionScope = 'collective-participation';
    },
    (m) => {
      m.queueCustody.revision = 0;
    },
  ]) {
    f.messages.getById = async (id) => {
      const m = await get(id);
      change(m);
      return m;
    };
    await assert.rejects(f.read);
  }
  f.messages.getById = get;
  f.threads.get = async () => ({ id: 'thread', createdBy: 'foreign' });
  await assert.rejects(f.read);
});

test('progress is withheld on revision, lifecycle, grant or thread drift across asynchronous reads', async () => {
  for (const change of [
    (m) => {
      m.queueCustody.entryId = 'replacement';
    },
    (m) => {
      m.extra.pluginMessage.revision++;
    },
    (m) => {
      m.queueCustody.revision++;
    },
    (m) => {
      m.source.meta.participation.eventId = 'other';
    },
  ]) {
    const f = fixture();
    let reads = 0;
    const get = f.messages.getById;
    f.messages.getById = async (id) => {
      const m = await get(id);
      if (++reads >= 2) change(m);
      return m;
    };
    await assert.rejects(f.read);
    assert.ok(reads >= 2);
  }
  const f = fixture();
  const get = f.messages.getById;
  f.messages.getById = async (id) => {
    const m = await get(id);
    f.deps.assertCurrent = async () => {
      throw Error('revoked');
    };
    return m;
  };
  await assert.rejects(f.read, /revoked/);
});
