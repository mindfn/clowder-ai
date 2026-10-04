import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { resolveQueueTurnCustodyWake } from '../dist/domains/ball-custody/turn-custody-wake-provenance.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import {
  assertQueueLedgerEntry,
  queueLedgerAdmissionFingerprint,
  queueLedgerAdmissionsMatch,
} from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { hydrateQueueLedgerEntry } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerCodec.js';

const noMessage = { getById: async () => null };
const ordinaryWake = { kind: 'unstructured', source: 'queue_delivery' };
function admission(overrides = {}) {
  return {
    sourceId: 'review-receipt-1',
    threadId: 'thread-review',
    owner: { kind: 'user', userId: 'operator' },
    kind: 'conversation_input',
    from: { kind: 'external', connectorId: 'content-review' },
    targetCatIds: ['codex'],
    content: 'continue the original Task',
    messageId: 'review-message-1',
    intent: 'execute',
    ownerAuthProvenance: 'strict',
    enqueuedAt: 100,
    sourceCategory: 'producer_return',
    ...overrides,
  };
}
const row = (overrides = {}) => createQueueLedgerAdmission(admission(overrides))[0];

test('producer_return survives the canonical ledger validation and Redis codec without inferred fields', () => {
  const entry = row();
  assert.doesNotThrow(() => assertQueueLedgerEntry(entry));
  assert.deepEqual(hydrateQueueLedgerEntry(JSON.stringify(entry)), entry);
  assert.equal(entry.execution.actionSuccessorFence, undefined);
  assert.equal(entry.execution.waitContinuationCarrier, undefined);
  assert.equal(entry.execution.a2aTriggerMessageId, undefined);
});

test('same-id return replay keeps its classification immutable in comparison and admission', async () => {
  const entry = row();
  const store = new InMemoryQueueLedgerStore();
  assert.equal((await store.enqueue([entry])).outcome, 'enqueued');
  assert.equal((await store.enqueue([row({ enqueuedAt: 200 })])).outcome, 'replayed');
  for (const category of [undefined, 'review', 'a2a', 'a2a_failure']) {
    const changed = row({ sourceCategory: category });
    assert.equal(queueLedgerAdmissionsMatch(entry, changed), false);
    assert.notEqual(queueLedgerAdmissionFingerprint(entry), queueLedgerAdmissionFingerprint(changed));
    assert.equal((await store.enqueue([changed])).outcome, 'conflict');
  }
  assert.deepEqual(await store.list(entry.threadId), [entry]);
});

test('a fresh Queue hydrates producer_return from the ledger, not the message text', async () => {
  const store = new InMemoryQueueLedgerStore();
  const entry = row();
  await store.enqueue([entry]);
  const restarted = new InvocationQueue(store);
  assert.equal(await restarted.hydrateFromLedger(), 1);
  const [restored] = restarted.list(entry.threadId, 'operator');
  assert.equal(restored.sourceCategory, 'producer_return');
  assert.deepEqual(await resolveQueueTurnCustodyWake(restored, noMessage), ordinaryWake);
});

test('plain producer return is lifecycle-owned without inventing dispatch or action custody', async () => {
  const wake = await resolveQueueTurnCustodyWake(row(), noMessage);
  assert.deepEqual(wake, ordinaryWake);
  const projections = new TurnCustodyProjectionService({});
  const opened = await projections.open(wake);
  assert.equal(opened.state, 'covered_empty');
  assert.equal((await projections.close(opened)).shouldBlock, false);
});

test('undeclared return-looking content remains legacy; unknown categories remain invalid', async () => {
  const unclassified = row({ sourceCategory: undefined, content: '[Host producer_return] continue review' });
  assert.deepEqual(await resolveQueueTurnCustodyWake(unclassified, noMessage), {
    kind: 'legacy',
    reason: 'carrier_missing',
  });
  assert.throws(() => assertQueueLedgerEntry(row({ sourceCategory: 'unrecognized_return' })), /source category/);
});

test('action fence takes precedence over a producer declaration', async () => {
  assert.deepEqual(
    await resolveQueueTurnCustodyWake(row({ actionSuccessorFence: { leaseId: 'lease-1', generation: 2 } }), noMessage),
    {
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 2,
      holderCatId: 'codex',
    },
  );
});

test('exact event-wait custody wins; a producer declaration cannot hide invalid or overlapping carriers', async () => {
  const waitContinuationCarrier = {
    v: 1,
    waitId: 'task-pr-7',
    outcomeId: 'wait:pr:owner/repo#7:g4:matched',
    ownerFence: { kind: 'action_successor', leaseId: 'lease-wait-4', generation: 4 },
  };
  const messages = {
    getById: async () => ({
      id: 'review-message-1',
      source: { connector: 'github-wait', meta: { waitContinuationCarrier } },
    }),
  };
  assert.deepEqual(await resolveQueueTurnCustodyWake(row({ waitContinuationCarrier }), messages), {
    kind: 'structured',
    protocol: 'event_wait',
    subjectKey: 'ball:thread:thread-review',
    holderCatId: 'codex',
    waitContinuationCarrier,
  });
  const rejected = { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'producer_return' };
  for (const overrides of [
    { waitContinuationCarrier: { ...waitContinuationCarrier, outcomeId: 'different-outcome' } },
    { waitContinuationCarrier, actionSuccessorFence: { leaseId: 'lease-1', generation: 2 } },
  ]) {
    assert.deepEqual(await resolveQueueTurnCustodyWake(row(overrides), messages), rejected);
  }
  assert.deepEqual(await resolveQueueTurnCustodyWake(row({ waitContinuationCarrier }), noMessage), rejected);
  assert.deepEqual(
    await resolveQueueTurnCustodyWake(row({ a2aTriggerMessageId: 'unbound-dispatch' }), noMessage),
    ordinaryWake,
  );
});

test('other declared Queue return classifications preserve the existing gate policy', async () => {
  for (const sourceCategory of ['ci', 'review', 'conflict', 'issue', 'continuation', 'a2a_failure']) {
    assert.deepEqual(await resolveQueueTurnCustodyWake(row({ sourceCategory }), noMessage), ordinaryWake);
  }
  const dispatch = row({ sourceCategory: 'a2a', from: { kind: 'agent', catId: 'opus' } });
  const wake = await resolveQueueTurnCustodyWake(dispatch, noMessage);
  assert.equal(wake.kind, 'structured');
  assert.equal(wake.protocol, 'dispatch');
  assert.equal(wake.handoff.messageId, dispatch.payload.messageId);
});
