import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

const sourceId = '0000000000001000-000001-00000001';

function fixture() {
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
    pluginPublicInvocation: carrier,
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
    assert.equal(
      typeof coordinator.bindPublicInvocationChild,
      'function',
      'missing atomic public child custody binding',
    );
    return coordinator.bindPublicInvocationChild({ entry, invocationId: 'child-1', ...input });
  };
  return { entry, store, port, coordinator, bind, writes: () => writes };
}

test('public child fixture has valid unbound queued custody before any new operation', () => {
  const f = fixture();
  assert.equal(f.store.getById(sourceId).queueCustody.status, 'queued');
  assert.equal(f.store.getById(sourceId).queueCustody.awakenedInvocationIdByCatId?.astra, undefined);
  assert.equal(f.writes(), 0);
});

test('public child binding atomically writes processing, exact witness and starting attempt in one CAS', async () => {
  const f = fixture();
  const original = structuredClone(f.store.getById(sourceId).queueCustody);
  const transition = f.port.transitionQueueCustody;
  f.port.transitionQueueCustody = async (id, input) => {
    assert.deepEqual(f.store.getById(sourceId).queueCustody, original);
    assert.equal(input.expectedRevision, original.revision);
    assert.equal(input.next.status, 'processing');
    assert.equal(input.next.awakenedInvocationIdByCatId.astra, 'child-1');
    assert.equal(input.next.targetAttempts.at(-1).state, 'starting');
    return transition(id, input);
  };
  const result = await f.bind();
  assert.equal(result.kind, 'bound');
  const stored = f.store.getById(sourceId).queueCustody;
  assert.deepEqual(result.custody, stored);
  assert.equal(stored.revision, original.revision + 1);
  assert.equal(stored.processingStartedAt, 2000);
  assert.equal(stored.awakenedAtByCatId.astra, 2000);
  assert.equal(stored.targetAttempts.at(-1).invocationId, 'child-1');
  assert.equal(stored.seenInvocationIdByCatId.astra, undefined, 'child creation must not manufacture prompt exposure');
  assert.deepEqual(stored.bodyExposures ?? [], []);
  assert.equal(f.writes(), 1);
  assert.equal(f.entry.status, 'queued', 'memory projection is updated by the caller only after CAS');
});

test('public child binding permits one winner across independent coordinator instances', async () => {
  const f = fixture();
  const other = new QueuedMessageCustodyCoordinator({ messageStore: f.port, now: () => 2000 });
  assert.equal(typeof other.bindPublicInvocationChild, 'function', 'missing atomic public child custody binding');
  const results = await Promise.all([
    f.bind(),
    other.bindPublicInvocationChild({ entry: f.entry, invocationId: 'child-2' }),
  ]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ['bound', 'conflict']);
  const winner = f.store.getById(sourceId).queueCustody.awakenedInvocationIdByCatId.astra;
  assert.ok(['child-1', 'child-2'].includes(winner));
  assert.equal(results.find((r) => r.kind === 'bound').custody.awakenedInvocationIdByCatId.astra, winner);
});

test('public child binding never rebinds an existing child including an identical replay', async () => {
  const f = fixture();
  assert.equal((await f.bind()).kind, 'bound');
  const original = structuredClone(f.store.getById(sourceId).queueCustody);
  assert.equal((await f.bind()).kind, 'conflict');
  assert.equal((await f.bind({ invocationId: 'child-2' })).kind, 'conflict');
  assert.deepEqual(f.store.getById(sourceId).queueCustody, original);
  assert.equal(f.writes(), 1);
});

test('public child binding captures coordinates before awaiting the store', async () => {
  const f = fixture();
  const get = f.port.getById;
  f.port.getById = async (id) => {
    f.entry.id = 'other';
    f.entry.userId = 'other';
    f.entry.pluginPublicInvocation.authorityRevision = 'other';
    f.entry.pluginPublicInvocation.actionMethods.push('owner.write');
    return get(id);
  };
  const result = await f.bind();
  assert.equal(result.kind, 'bound');
  assert.equal(result.custody.entryId, 'entry');
  assert.equal(result.custody.pluginPublicInvocation.authorityRevision, 'r1');
});

test('public child binding rejects widened or malformed input before storage access', async () => {
  const f = fixture();
  assert.equal(
    typeof f.coordinator.bindPublicInvocationChild,
    'function',
    'missing atomic public child custody binding',
  );
  f.port.getById = async () => assert.fail('invalid input must not read storage');
  for (const mutate of [
    (e) => {
      delete e.pluginPublicInvocation;
    },
    (e) => {
      e.ownerAuthProvenance = 'strict';
    },
    (e) => {
      e.mergedMessageIds = ['extra'];
    },
    (e) => {
      e.targetCats = ['astra', 'opus'];
    },
    (e) => {
      e.messageId = 'foreign';
    },
    (e) => {
      e.status = 'processing';
    },
  ]) {
    const entry = structuredClone(f.entry);
    mutate(entry);
    await assert.rejects(() => f.bind({ entry }));
  }
  await assert.rejects(() => f.bind({ invocationId: '' }));
  assert.equal(f.writes(), 0);
});

test('public child binding rejects absent, foreign and stale source custody without CAS', async () => {
  const f = fixture();
  assert.equal(
    typeof f.coordinator.bindPublicInvocationChild,
    'function',
    'missing atomic public child custody binding',
  );
  const original = structuredClone(f.store.getById(sourceId));
  for (const mutate of [
    () => null,
    (m) => {
      m.userId = 'other';
      return m;
    },
    (m) => {
      m.threadId = 'other';
      return m;
    },
    (m) => {
      m.queueCustody.entryId = 'other';
      return m;
    },
    (m) => {
      m.extra.pluginMessage.revision++;
      return m;
    },
    (m) => {
      m.extra.pluginMessage.instanceId = 'other';
      return m;
    },
    (m) => {
      m.queueCustody.pluginPublicInvocation.authorityRevision = 'other';
      return m;
    },
    (m) => {
      m.deliveryStatus = 'canceled';
      return m;
    },
    (m) => {
      m.recall = { exposure: 'unseen' };
      return m;
    },
    (m) => {
      m.deletedAt = 1500;
      return m;
    },
  ]) {
    f.port.getById = async () => mutate(structuredClone(original));
    assert.equal((await f.bind()).kind, 'conflict');
  }
  assert.equal(f.writes(), 0);
});

test('public child binding rejects prior witnesses, retirement and terminal target state', async () => {
  const f = fixture();
  assert.equal(
    typeof f.coordinator.bindPublicInvocationChild,
    'function',
    'missing atomic public child custody binding',
  );
  const original = structuredClone(f.store.getById(sourceId));
  for (const mutate of [
    (c) => {
      c.status = 'processing';
      c.processingStartedAt = 1500;
    },
    (c) => {
      c.status = 'terminal';
      c.pendingTargetCats = [];
    },
    (c) => {
      c.awakenedInvocationIdByCatId = { astra: 'old-child' };
      c.awakenedAtByCatId = { astra: 1500 };
    },
    (c) => {
      c.failedByCatIds = ['astra'];
    },
    (c) => {
      c.handledByCatIds = ['astra'];
    },
    (c) => {
      c.withdrawnByCatIds = ['astra'];
    },
    (c) => {
      c.steerRequestedByCatIds = ['astra'];
    },
    (c) => {
      c.prestartRetirement = { id: 'retire' };
    },
  ]) {
    const message = structuredClone(original);
    mutate(message.queueCustody);
    f.port.getById = async () => structuredClone(message);
    assert.equal((await f.bind()).kind, 'conflict');
  }
  assert.equal(f.writes(), 0);
});

test('public child binding returns conflict on CAS loss without retrying a new generation', async () => {
  const f = fixture();
  let attempts = 0;
  f.port.transitionQueueCustody = async () => {
    attempts++;
    return { kind: 'revision_mismatch', actualRevision: 2 };
  };
  assert.equal((await f.bind()).kind, 'conflict');
  assert.equal(attempts, 1);
  assert.equal(f.store.getById(sourceId).queueCustody.status, 'queued');
});

test('public child binding propagates storage failure without claiming a winner', async () => {
  const f = fixture();
  assert.equal(
    typeof f.coordinator.bindPublicInvocationChild,
    'function',
    'missing atomic public child custody binding',
  );
  f.port.transitionQueueCustody = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(() => f.bind(), /storage unavailable/);
  assert.equal(f.store.getById(sourceId).queueCustody.status, 'queued');
});

test('public child binding returns a detached canonical custody snapshot', async () => {
  const f = fixture();
  const result = await f.bind();
  assert.equal(result.kind, 'bound');
  const before = structuredClone(f.store.getById(sourceId).queueCustody);
  try {
    result.custody.awakenedInvocationIdByCatId.astra = 'forged';
  } catch {}
  try {
    result.custody.pluginPublicInvocation.actionMethods.push('owner.write');
  } catch {}
  assert.deepEqual(f.store.getById(sourceId).queueCustody, before);
});

test('public child binding refuses a stale canonical response after the CAS was applied', async () => {
  const f = fixture();
  const transition = f.port.transitionQueueCustody;
  f.port.transitionQueueCustody = async (id, input) => {
    const result = structuredClone(await transition(id, input));
    result.message.extra.pluginMessage.revision++;
    return result;
  };
  assert.equal((await f.bind()).kind, 'conflict');
  assert.equal(f.writes(), 1);
  assert.equal(f.store.getById(sourceId).queueCustody.status, 'processing');
});

test('public child binding does not overwrite cancellation between read and CAS', async () => {
  const f = fixture();
  const transition = f.port.transitionQueueCustody;
  f.port.transitionQueueCustody = async (id, input) => {
    f.store.markCanceled(id);
    return transition(id, input);
  };
  assert.equal((await f.bind()).kind, 'conflict');
  assert.equal(f.store.getById(sourceId).deliveryStatus, 'canceled');
  assert.equal(f.store.getById(sourceId).queueCustody, undefined);
});

test('public child binding rejects prior terminal attempts even when top-level witnesses are absent', async () => {
  const f = fixture();
  const get = f.port.getById;
  f.port.getById = async (id) => {
    const message = await get(id);
    message.queueCustody.targetAttempts[0] = {
      ...message.queueCustody.targetAttempts[0],
      state: 'interrupted',
      terminalReason: 'runtime_restart',
      invocationId: 'previous-child',
    };
    return message;
  };
  assert.equal((await f.bind()).kind, 'conflict');
  assert.equal(f.writes(), 0);
});

test('public child binding rejects source body or provenance drift after CAS', async () => {
  for (const change of [
    (message) => {
      message.content = 'replacement';
    },
    (message) => {
      message.source.connector = 'replacement';
    },
  ]) {
    const f = fixture();
    const transition = f.port.transitionQueueCustody;
    f.port.transitionQueueCustody = async (id, input) => {
      const result = structuredClone(await transition(id, input));
      change(result.message);
      return result;
    };
    assert.equal((await f.bind()).kind, 'conflict');
    assert.equal(f.writes(), 1);
  }
});
