import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InvocationQueue,
  isOrdinaryQueueTargetEligible,
} from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { buildQueueEntry } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupQueueEntry.ts';

function entry() {
  return {
    id: 'entry',
    threadId: 'thread',
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    messageId: 'trigger',
    mergedMessageIds: [],
    content: 'Host Task trigger',
    source: 'user',
    sourceCategory: 'plugin_task',
    targetCats: ['codex'],
    allTargetCats: ['codex'],
    intent: 'execute',
    status: 'queued',
    createdAt: 1000,
    autoExecute: true,
    priority: 'normal',
  };
}
function stored(e = entry()) {
  return {
    id: e.messageId,
    userId: e.userId,
    threadId: e.threadId,
    catId: null,
    content: e.content,
    timestamp: 1000,
    mentions: [],
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(e),
  };
}
test('Task entry is excluded from ordinary selection and batching', () => {
  const e = entry(),
    q = new InvocationQueue();
  q.restoreDurableEntry(e);
  assert.equal(isOrdinaryQueueTargetEligible(e, 'codex'), false);
  assert.equal(q.markProcessingById('thread', 'entry', 'codex'), false);
  assert.deepEqual(q.collectUserBatch('thread', 'owner'), []);
});
test('unstarted Task recovery preserves isolated auto scheduling', () => {
  const e = buildQueueEntry([stored()], 'entry');
  assert.equal(e.sourceCategory, 'plugin_task');
  assert.equal(e.autoExecute, true);
  assert.equal(e.ownerAuthProvenance, 'unknown');
});
for (const mutation of [
  (m) => {
    m.queueCustody.carrierStateByTargetCatId = { codex: { status: 'queued' } };
  },
  (m) => {
    m.queueCustody.awakenedInvocationIdByCatId = { codex: 'old-child' };
  },
  (m) => {
    m.queueCustody.ownerAuthProvenance = 'owner';
  },
  (m) => {
    m.source = { connector: 'ordinary' };
  },
])
  test('Task startup rejects mixed or previously started custody ' + mutation.toString(), () => {
    const m = stored();
    mutation(m);
    assert.throws(() => buildQueueEntry([m], 'entry'), /task|custody/i);
  });
test('Task claim is single-use, leaves durable binding to child CAS', () => {
  const q = new InvocationQueue();
  q.restoreDurableEntry(entry());
  const claimed = q.claimTaskInvocation('thread', 'owner', 'entry');
  assert.equal(claimed.status, 'queued');
  assert.equal(q.claimTaskInvocation('thread', 'owner', 'entry'), null);
  assert.equal(q.getEntrySnapshot('thread', 'owner', 'entry').status, 'processing');
});
test('Task identity cannot be downgraded by replacing its queue snapshot', () => {
  const q = new InvocationQueue();
  q.restoreDurableEntry(entry());
  const old = q.getEntrySnapshot('thread', 'owner', 'entry');
  assert.equal(q.restoreEntrySnapshotIfUnchanged(old, { ...old, sourceCategory: undefined }), false);
});

test('Task snapshots cannot mutate the live lane and generic durable retry is forbidden', async () => {
  const q = new InvocationQueue();
  q.restoreDurableEntry(entry());
  const snapshot = q.list('thread', 'owner')[0];
  snapshot.sourceCategory = undefined;
  snapshot.targetCats.push('opus');
  assert.equal(q.getEntrySnapshot('thread', 'owner', 'entry').sourceCategory, 'plugin_task');
  assert.deepEqual(q.getEntrySnapshot('thread', 'owner', 'entry').targetCats, ['codex']);
  const { isPublicInvocationRetryForbidden } = await import(
    '../src/domains/cats/services/stores/ports/public-invocation-queue-retry.ts'
  );
  assert.equal(isPublicInvocationRetryForbidden(stored().queueCustody, 'codex'), true);
});

test('Task processing exposure requires the exact bound child', () => {
  const q = new InvocationQueue();
  q.restoreDurableEntry(entry());
  q.claimTaskInvocation('thread', 'owner', 'entry');
  assert.deepEqual(q.markProcessingSeen('thread', 'owner', 'entry', ['codex'], 'foreign', 1002), []);
  const current = q.getEntrySnapshot('thread', 'owner', 'entry');
  q.restoreEntrySnapshotIfUnchanged(current, { ...current, queuedAwakenedInvocationIdByCatId: { codex: 'exact' } });
  assert.deepEqual(q.markProcessingSeen('thread', 'owner', 'entry', ['codex'], 'foreign', 1002), []);
  assert.deepEqual(q.markProcessingSeen('thread', 'owner', 'entry', ['codex'], 'exact', 1002), ['codex']);
});

test('generic enqueue deduplication cannot change an existing Task lane or promote ordinary work', () => {
  for (const [before, after] of [
    [undefined, 'plugin_task'],
    ['plugin_task', undefined],
  ]) {
    const q = new InvocationQueue();
    q.enqueue({ ...entry(), idempotencyKey: 'same', sourceCategory: before });
    assert.throws(() => q.enqueue({ ...entry(), idempotencyKey: 'same', sourceCategory: after }), /Task Queue lane/);
  }
});
