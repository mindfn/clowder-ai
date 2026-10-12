import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { ensurePersistedCarrierOwnedAndScheduled } from '../dist/domains/cats/services/agents/invocation/PersistedQueueCarrier.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { buildQueueEntry } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.js';
import {
  assertQueueCustodyTransition,
  assertQueuedMessageCustody,
  cloneQueuedMessageCustody,
  parseQueuedMessageCustody,
} from '../dist/domains/cats/services/stores/ports/queued-message-custody.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

// Host-owned coordinates, not a package body or provider launch capability.
function carrier(overrides = {}) {
  return {
    version: 1,
    admissionId: 'public-admission-1',
    sourceMessageId: 'source-1',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance-1',
    packageDigest: 'sha256:package-1',
    lifecycleRevision: 3,
    grantRevision: 2,
    contributionId: 'native-actions',
    actionMethods: ['participation.read', 'participation.reply'],
    targetCatId: 'codex',
    authorityRef: 'participation:channel-1',
    authorityRevision: 'revision-1',
    ...overrides,
  };
}
function custody(publicInvocation = carrier()) {
  return makeQueuedMessageCustody({
    ownerUserId: 'owner-1',
    ownerAuthProvenance: 'unknown',
    intent: 'execute',
    allTargetCats: ['codex'],
    pendingTargetCats: ['codex'],
    pluginPublicInvocation: publicInvocation,
  });
}
function message(overrides = {}) {
  return {
    id: 'source-1',
    userId: 'owner-1',
    threadId: 'thread-1',
    catId: null,
    content: 'External public input',
    source: { connector: 'example-plugin' },
    timestamp: 1000,
    mentions: ['codex'],
    deliveryStatus: 'queued',
    queueCustody: custody(),
    extra: { pluginMessage: { instanceId: 'instance-1', revision: 1 } },
    ...overrides,
  };
}
function enqueueInput(overrides = {}) {
  return {
    threadId: 'thread-1',
    userId: 'owner-1',
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'External public input',
    messageId: 'source-1',
    targetCats: ['codex'],
    intent: 'execute',
    autoExecute: true,
    pluginPublicInvocation: carrier(),
    ...overrides,
  };
}

test('public custody rejects malformed or widened authority instead of preserving unknown data', () => {
  assert.doesNotThrow(() => assertQueuedMessageCustody(custody()));
  for (const mutation of [
    { version: 2 },
    { admissionId: '' },
    { actionMethods: [] },
    { actionMethods: ['participation.read', 'participation.read'] },
    { sourcePluginRevision: -1 },
    { lifecycleRevision: -1 },
    { targetCatId: 'opus' },
    { authorityRevision: '' },
    { provider: 'arbitrary-cli' },
  ]) {
    assert.throws(() => assertQueuedMessageCustody(custody(carrier(mutation))), /public|carrier|authority/i);
    assert.throws(() => parseQueuedMessageCustody(JSON.stringify(custody(carrier(mutation)))), {
      code: 'INVALID_QUEUE_CUSTODY',
    });
  }
});

test('custody clone detaches the public method scope from a mutable caller', () => {
  const original = custody();
  const copy = cloneQueuedMessageCustody(original);
  copy.pluginPublicInvocation.actionMethods.push('owner.write');
  assert.deepEqual(original.pluginPublicInvocation.actionMethods, ['participation.read', 'participation.reply']);
});

test('ordinary Queue transitions cannot add, remove or replace public authority', () => {
  const original = custody();
  for (const nextCarrier of [
    undefined,
    carrier({ authorityRevision: 'revision-2' }),
    carrier({ sourceMessageId: 'other' }),
  ]) {
    const next = { ...structuredClone(original), revision: 2, updatedAt: 1001 };
    if (nextCarrier) next.pluginPublicInvocation = nextCarrier;
    else delete next.pluginPublicInvocation;
    assert.throws(
      () => assertQueueCustodyTransition(original, { expectedRevision: 1, next }),
      /public|carrier|immutable/i,
    );
  }
  const ordinary = custody();
  delete ordinary.pluginPublicInvocation;
  assert.throws(
    () =>
      assertQueueCustodyTransition(ordinary, {
        expectedRevision: 1,
        next: { ...original, revision: 2, updatedAt: 1001 },
      }),
    /public|carrier|immutable/i,
  );
});

test('initial durable custody retains the complete public authority without aliasing', () => {
  const entry = {
    ...enqueueInput(),
    id: 'entry-1',
    status: 'queued',
    createdAt: 1000,
    priority: 'normal',
    mergedMessageIds: [],
  };
  const stored = createInitialQueuedMessageCustody(entry);
  assert.deepEqual(stored.pluginPublicInvocation, entry.pluginPublicInvocation, 'Missing durable public authority');
  entry.pluginPublicInvocation.actionMethods.push('owner.write');
  assert.equal(stored.pluginPublicInvocation.actionMethods.length, 2);
});

test('restart restores exact public carrier and automatic scheduling without inventing owner or A2A authority', () => {
  const stored = message();
  const restored = buildQueueEntry([stored], 'entry-1');
  assert.deepEqual(restored.pluginPublicInvocation, carrier(), 'Missing recovered public authority');
  assert.equal(restored.autoExecute, true);
  assert.equal(restored.ownerAuthProvenance, 'unknown');
  assert.equal(restored.a2aTriggerMessageId, undefined);
  stored.queueCustody.pluginPublicInvocation.actionMethods.push('owner.write');
  assert.equal(restored.pluginPublicInvocation.actionMethods.length, 2);
});

test('restart refuses rebinding a public carrier to another source or merging it with another body', () => {
  const source = message();
  assert.throws(() => buildQueueEntry([message({ id: 'other-source' })], 'entry-1'), /public|source|carrier/i);
  assert.throws(
    () => buildQueueEntry([source, message({ id: 'sibling', timestamp: 1001 })], 'entry-1'),
    /public|source|carrier/i,
  );
});

test('durable scheduling refuses a live carrier whose public authority differs from storage', async () => {
  const source = message();
  const live = buildQueueEntry([source], 'entry-1');
  live.pluginPublicInvocation = carrier({ authorityRevision: 'forged' });
  let progressed = 0;
  const result = await ensurePersistedCarrierOwnedAndScheduled(
    {
      messages: {
        getById: async () => structuredClone(source),
        getByThreadAfter: async () => [structuredClone(source)],
      },
      queue: { getEntrySnapshot: () => structuredClone(live), restoreDurableEntry: () => 'existing' },
      progress: async () => {
        progressed += 1;
        return 'started';
      },
    },
    { sourceMessageId: source.id, ownerUserId: 'owner-1', threadId: 'thread-1', targetCatId: 'codex' },
  );
  assert.equal(result.state, 'conflict');
  assert.equal(progressed, 0);
});

test('Queue enqueue preserves public authority without sharing the callers method array', () => {
  const queue = new InvocationQueue();
  const input = enqueueInput();
  const result = queue.enqueue(input);
  assert.equal(result.outcome, 'enqueued');
  assert.deepEqual(result.entry.pluginPublicInvocation, carrier(), 'Missing live public authority');
  input.pluginPublicInvocation.actionMethods.push('owner.write');
  assert.equal(
    queue.getEntrySnapshot('thread-1', 'owner-1', result.entry.id).pluginPublicInvocation.actionMethods.length,
    2,
  );
});

test('Queue rejects public carriers on ordinary user, owner-authenticated or mismatched target paths', () => {
  for (const mutation of [
    { source: 'user' },
    { ownerAuthProvenance: 'strict' },
    { targetCats: ['opus'] },
    { targetCats: ['codex', 'opus'] },
    { autoExecute: false },
    { messageId: 'other-source' },
  ]) {
    assert.throws(() => new InvocationQueue().enqueue(enqueueInput(mutation)), /public|carrier|source|target/i);
  }
});

test('ordinary queued messages keep their existing passive restart behavior', () => {
  const stored = message();
  delete stored.queueCustody.pluginPublicInvocation;
  assertQueuedMessageCustody(stored.queueCustody);
  const restored = buildQueueEntry([stored], 'entry-1');
  assert.equal(restored.pluginPublicInvocation, undefined);
  assert.equal(restored.autoExecute, false);
});

test('public carriers cannot be selected or exposed through ordinary Queue execution', () => {
  const queue = new InvocationQueue();
  const entry = queue.enqueue(enqueueInput()).entry;
  assert.equal(queue.dequeue('thread-1', 'owner-1'), null);
  assert.equal(queue.hasOrdinaryEligibleQueuedForThread('thread-1'), false);
  assert.deepEqual(queue.getQueuedFreshnessMessagesForCat('thread-1', 'owner-1', 'codex'), []);
  assert.equal(queue.getEntrySnapshot('thread-1', 'owner-1', entry.id).status, 'queued');
  assert.throws(() => queue.backfillMessageId('thread-1', 'owner-1', entry.id, 'other-source'), /public|source/i);
});

test('public authority stays detached through Queue list and replay snapshots', () => {
  const queue = new InvocationQueue();
  const input = enqueueInput({ idempotencyKey: 'admission-1' });
  const entry = queue.enqueue(input).entry;
  queue.list('thread-1', 'owner-1')[0].pluginPublicInvocation.actionMethods.push('owner.write');
  queue.findEntryWithMessageId('thread-1', 'source-1').pluginPublicInvocation.actionMethods.push('owner.write');
  queue.enqueue(input).entry.pluginPublicInvocation.actionMethods.push('owner.write');
  assert.deepEqual(queue.getEntrySnapshot('thread-1', 'owner-1', entry.id).pluginPublicInvocation, carrier());
  assert.throws(
    () => queue.enqueue({ ...input, pluginPublicInvocation: carrier({ authorityRevision: 'changed' }) }),
    /public|carrier/i,
  );
});

test('valid carrier JSON survives persistence and source provenance drift cannot be recovered', () => {
  const stored = message();
  stored.queueCustody = parseQueuedMessageCustody(JSON.stringify(stored.queueCustody));
  assert.deepEqual(stored.queueCustody.pluginPublicInvocation, carrier());
  for (const extra of [
    { pluginMessage: { instanceId: 'other', revision: 1 } },
    { pluginMessage: { instanceId: 'instance-1', revision: 2 } },
  ]) {
    assert.throws(() => buildQueueEntry([{ ...stored, extra }], 'entry-1'), /public|source|carrier/i);
  }
});

test('Queue snapshot rollback cannot remove or replace public authority', () => {
  const queue = new InvocationQueue();
  const entry = queue.enqueue(enqueueInput()).entry;
  for (const replacement of [
    { ...entry, pluginPublicInvocation: undefined },
    { ...entry, pluginPublicInvocation: carrier({ authorityRevision: 'changed' }) },
    { ...entry, messageId: 'other-source' },
  ]) {
    assert.throws(() => queue.restoreEntrySnapshotIfUnchanged(entry, replacement), /public|carrier/i);
  }
  assert.deepEqual(queue.getEntrySnapshot('thread-1', 'owner-1', entry.id), entry);
  assert.equal(queue.restoreEntrySnapshotIfUnchanged(entry, { ...entry, priority: 'urgent' }), true);
});

// Review 865: all ordinary consumers must bypass public custody without starving ordinary entries.
test('ordinary peek bypasses public head and preserves both entries', () => {
  const queue = new InvocationQueue();
  const external = queue.enqueue(enqueueInput()).entry;
  const ordinary = queue.enqueue(enqueueInput({ pluginPublicInvocation: undefined, messageId: 'ordinary' })).entry;
  assert.equal(queue.peek('thread-1', 'owner-1')?.id, ordinary.id);
  assert.deepEqual(queue.getEntrySnapshot('thread-1', 'owner-1', external.id), external);
  assert.equal(queue.list('thread-1', 'owner-1').length, 2);
});

test('ordinary dequeue bypasses public head without deleting its authority', () => {
  const queue = new InvocationQueue();
  const external = queue.enqueue(enqueueInput()).entry;
  const ordinary = queue.enqueue(enqueueInput({ pluginPublicInvocation: undefined, messageId: 'ordinary' })).entry;
  assert.equal(queue.dequeue('thread-1', 'owner-1')?.id, ordinary.id);
  assert.equal(queue.dequeue('thread-1', 'owner-1'), null);
  assert.equal(queue.peek('thread-1', 'owner-1'), null);
  assert.deepEqual(queue.getEntrySnapshot('thread-1', 'owner-1', external.id), external);
});

test('ordinary batch collection bypasses public head without exposing its body', () => {
  const queue = new InvocationQueue();
  const external = queue.enqueue(enqueueInput()).entry;
  const ordinary = queue.enqueue(enqueueInput({ pluginPublicInvocation: undefined, messageId: 'ordinary' })).entry;
  assert.deepEqual(
    queue.collectUserBatch('thread-1', 'owner-1').map((entry) => entry.id),
    [ordinary.id],
  );
  assert.deepEqual(queue.getEntrySnapshot('thread-1', 'owner-1', external.id), external);
});
