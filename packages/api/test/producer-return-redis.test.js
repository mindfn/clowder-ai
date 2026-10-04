import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { resolveQueueTurnCustodyWake } from '../dist/domains/ball-custody/turn-custody-wake-provenance.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { PersistedQueueDelivery } from '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { createQueueLedgerAdmission } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
describe('producer return Redis durability', { skip: redisIsolationSkipReason(redisUrl) }, () => {
  let redis;
  let ledger;
  let messages;
  const prefix = `f167-producer-return:${randomUUID()}:`;
  before(async () => {
    assertRedisIsolationOrThrow(redisUrl, 'producer return Redis durability');
    redis = createRedisClient({ url: redisUrl, keyPrefix: prefix });
    await redis.ping();
    ledger = new RedisQueueLedgerStore(redis);
    messages = new RedisMessageStore(redis);
  });
  // Keep test records for diagnosis. This suite never flushes or deletes a keyspace.
  after(async () => {
    if (redis) await redis.quit();
  });

  it('real public delivery restores the producer declaration and rejects a changed-category replay', async () => {
    const queue = new InvocationQueue(ledger);
    const progressed = [];
    const delivery = new PersistedQueueDelivery({
      messages,
      queue,
      progress: async (entry) => {
        progressed.push(entry.id);
        return 'owned_deferred_busy';
      },
    });
    const input = {
      ownerUserId: 'operator',
      threadId: 'thread-review',
      targetCatId: 'codex',
      idempotencyKey: 'review-return',
      content: 'resume the original Task',
      sourceCategory: 'producer_return',
      ownerAuthProvenance: 'strict',
      source: {
        connector: 'content-review',
        label: 'Review',
        icon: 'cat-cafe',
        meta: { reviewReceiptRef: 'receipt:1' },
      },
    };
    const admitted = await delivery.deliver(input);
    assert.equal(admitted.state, 'owned_deferred_busy');
    const replay = await delivery.deliver(input);
    assert.equal(replay.state, 'owned_deferred_busy', JSON.stringify(replay));
    assert.equal(replay.message.id, admitted.message.id);
    assert.equal(replay.entryId, admitted.entryId);
    assert.equal(queue.list(input.threadId, 'operator').length, 1);
    const progressCount = progressed.length;
    for (const sourceCategory of [undefined, 'review']) {
      assert.equal((await delivery.deliver({ ...input, sourceCategory })).state, 'conflict');
    }
    assert.equal(progressed.length, progressCount);

    const restarted = new InvocationQueue(new RedisQueueLedgerStore(redis));
    assert.equal(await restarted.hydrateFromLedger(), 1);
    const [restored] = restarted.list(input.threadId, 'operator');
    assert.equal(restored.sourceCategory, 'producer_return');
    assert.equal(restored.payload.messageId, admitted.message.id);
    assert.deepEqual(await resolveQueueTurnCustodyWake(restored, messages), {
      kind: 'unstructured',
      source: 'queue_delivery',
    });
    assert.equal(restored.execution.actionSuccessorFence, undefined);
    assert.equal(restored.execution.waitContinuationCarrier, undefined);
    assert.equal(restored.execution.a2aTriggerMessageId, undefined);
    assert.equal(await redis.ttl(`queue:{${input.threadId}}:entries`), -1);
  });

  it('Redis admission replay preserves producer_return as part of the immutable fingerprint', async () => {
    const input = {
      sourceId: 'fingerprint-return',
      threadId: 'thread-fingerprint',
      owner: { kind: 'user', userId: 'operator' },
      kind: 'private_input',
      from: { kind: 'system', service: 'test-producer' },
      targetCatIds: ['codex'],
      content: 'resume',
      intent: 'execute',
      enqueuedAt: 100,
      ownerAuthProvenance: 'strict',
      sourceCategory: 'producer_return',
    };
    const rows = createQueueLedgerAdmission(input);
    assert.equal((await ledger.enqueue(rows)).outcome, 'enqueued');
    assert.equal((await ledger.enqueue(rows)).outcome, 'replayed');
    for (const sourceCategory of [undefined, 'review', 'a2a_failure']) {
      assert.equal(
        (await ledger.enqueue(createQueueLedgerAdmission({ ...input, sourceCategory }))).outcome,
        'conflict',
      );
    }
    assert.deepEqual(await new RedisQueueLedgerStore(redis).list(input.threadId), rows);
  });

  it('a claimed return can be restored after a process interruption without changing category', async () => {
    const [entry] = await ledger.list('thread-fingerprint');
    assert.equal(
      (await ledger.claim(entry.threadId, entry.id, 'claim-before-restart', 200, 'codex')).outcome,
      'claimed',
    );
    const restarted = new RedisQueueLedgerStore(redis);
    assert.equal((await restarted.restore(entry.threadId, entry.id, 'wrong-claim')).outcome, 'state_changed');
    assert.equal((await restarted.restore(entry.threadId, entry.id, 'claim-before-restart')).outcome, 'updated');
    assert.deepEqual(await restarted.get(entry.threadId, entry.id), entry);
  });

  it('retired private returns cannot be resurrected or replayed under a different category', async () => {
    const queue = new InvocationQueue(ledger);
    const delivery = new PersistedQueueDelivery({ messages, queue, progress: async () => 'owned_deferred_busy' });
    const input = {
      ownerUserId: 'operator',
      threadId: 'thread-private-return',
      targetCatId: 'codex',
      idempotencyKey: 'private-return',
      content: 'resume',
      from: { kind: 'system', service: 'test-producer' },
      sourceCategory: 'producer_return',
      ownerAuthProvenance: 'strict',
    };
    const first = await delivery.deliverPrivate(input);
    assert.equal(first.admitted, true);
    assert.equal((await ledger.claim(input.threadId, first.entryId, 'private-claim', 300, 'codex')).outcome, 'claimed');
    assert.equal(
      (await ledger.commit(input.threadId, first.entryId, 'private-claim', 'processing', 301)).outcome,
      'updated',
    );
    const restartedLedger = new RedisQueueLedgerStore(redis);
    const restartedDelivery = new PersistedQueueDelivery({
      messages,
      queue: new InvocationQueue(restartedLedger),
      progress: async () => assert.fail('retired work must not progress again'),
    });
    assert.equal((await restartedDelivery.deliverPrivate(input)).admitted, true);
    for (const sourceCategory of [undefined, 'review']) {
      await assert.rejects(() => restartedDelivery.deliverPrivate({ ...input, sourceCategory }));
    }
    assert.deepEqual(await restartedLedger.list(input.threadId), []);
  });
});
