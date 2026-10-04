import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { ensurePersistedCarrierOwnedAndScheduled } from '../src/domains/cats/services/agents/invocation/PersistedQueueCarrier.js';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import './helpers/setup-cat-registry.js';

const input = {
  ownerUserId: 'operator',
  threadId: 't-review',
  targetCatId: 'codex',
  idempotencyKey: 'review-return',
  content: 'continue the entrusted Task',
  source: { connector: 'content-review', label: 'Review', icon: 'cat-cafe', meta: { reviewReceiptRef: 'receipt:1' } },
};

function fixture(progress: 'started' | 'owned_deferred_busy' = 'started') {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const progressed: string[] = [];
  const delivery = new PersistedQueueDelivery({
    messages,
    queue,
    progress: async (entry) => {
      progressed.push(entry.id);
      return progress;
    },
  });
  return { messages, queue, delivery, progressed };
}

test('producer delivery atomically persists one Message and canonical Queue row', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver(input);
  assert.equal(delivered.state, 'started');
  assert.ok(delivered.message);
  assert.equal(delivered.message.deliveryStatus, 'queued');
  assert.equal(delivered.message.queueCustody, undefined, 'History must not mirror Queue ledger state');
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(entry?.payload.messageId, delivered.message.id);
  assert.deepEqual(entry?.targets, [input.targetCatId]);
  assert.deepEqual(f.progressed, [delivered.entryId]);
});

test('idempotent producer replay reuses the same Message and Queue identity', async () => {
  const f = fixture('owned_deferred_busy');
  const first = await f.delivery.deliver(input);
  const replay = await f.delivery.deliver(input);
  assert.equal(first.message?.id, replay.message?.id);
  assert.equal('entryId' in first && 'entryId' in replay && first.entryId, replay.entryId);
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 1);
});

test('producer return replay cannot reclassify a persisted Queue envelope', async () => {
  const f = fixture('owned_deferred_busy');
  const declared = { ...input, sourceCategory: 'producer_return' as const };
  const first = await f.delivery.deliver(declared);
  const replay = await f.delivery.deliver(declared);
  assert.equal(replay.state, 'owned_deferred_busy');
  assert.equal(replay.message?.id, first.message?.id);
  const progressed = f.progressed.length;
  for (const sourceCategory of [undefined, 'review'] as const) {
    const conflict = await f.delivery.deliver({ ...input, sourceCategory });
    assert.equal(conflict.state, 'conflict');
  }
  assert.equal(f.progressed.length, progressed, 'conflicting replay must not progress the original work');
  assert.equal(f.queue.list(input.threadId, input.ownerUserId)[0]?.sourceCategory, 'producer_return');
});

test('declaring producer_return does not rewrite an older unclassified pending row', async () => {
  const f = fixture('owned_deferred_busy');
  await f.delivery.deliver(input);
  const progressed = f.progressed.length;
  assert.equal((await f.delivery.deliver({ ...input, sourceCategory: 'producer_return' })).state, 'conflict');
  assert.equal(f.progressed.length, progressed);
  assert.equal(f.queue.list(input.threadId, input.ownerUserId)[0]?.sourceCategory, undefined);
});

test('an idempotency collision with a different immutable envelope fails closed', async () => {
  const f = fixture();
  await f.delivery.deliver(input);
  const conflict = await f.delivery.deliver({ ...input, content: 'different content' });
  assert.equal(conflict.state, 'conflict');
  assert.equal(f.queue.list(input.threadId, input.ownerUserId).length, 1);
});

test('recovery schedules only exact persisted source and Queue coordinates', async () => {
  const f = fixture();
  const admitted = await f.delivery.deliver(input);
  assert.ok(admitted.message && 'entryId' in admitted);
  const progress = async () => 'owned_deferred_busy' as const;
  const exact = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.deepEqual(exact, { state: 'owned_deferred_busy', entryId: admitted.entryId });

  const missingIdentity = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, sourceMessageId: admitted.message.id },
  );
  assert.equal(missingIdentity.state, 'conflict');

  const wrongTarget = await ensurePersistedCarrierOwnedAndScheduled(
    { messages: f.messages, queue: f.queue, progress },
    { ...input, targetCatId: 'opus', sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.equal(wrongTarget.state, 'conflict');
});

test('claimed carrier is recognized as already processing without another progress request', async () => {
  const f = fixture();
  const admitted = await f.delivery.deliver(input);
  assert.ok(admitted.message && 'entryId' in admitted);
  const claimed = await f.queue.claimExactSteerEntryDurable(
    input.threadId,
    input.ownerUserId,
    admitted.entryId,
    input.targetCatId,
  );
  assert.equal(claimed.outcome, 'claimed');
  let progressed = false;
  const result = await ensurePersistedCarrierOwnedAndScheduled(
    {
      messages: f.messages,
      queue: f.queue,
      progress: async () => {
        progressed = true;
        return 'started';
      },
    },
    { ...input, sourceMessageId: admitted.message.id, expectedEntryId: admitted.entryId },
  );
  assert.deepEqual(result, { state: 'already_processing', entryId: admitted.entryId });
  assert.equal(progressed, false);
});

test('a producer that states no provenance fails closed as unknown, never strict', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver(input);
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(
    entry?.execution.ownerAuthProvenance,
    'unknown',
    'strict is what grants a ManagedWorkBinding, so it must never be inherited by default',
  );
});

test('a producer that owns an authenticated continuation states strict explicitly', async () => {
  const f = fixture();
  const delivered = await f.delivery.deliver({ ...input, ownerAuthProvenance: 'strict' });
  assert.ok('entryId' in delivered);
  const entry = await f.queue.getDurableEntry(input.threadId, delivered.entryId);
  assert.equal(entry?.execution.ownerAuthProvenance, 'strict');
});
