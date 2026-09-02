import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('ADR-043 Redis queue ledger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let queueEntryId;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'ADR-043 Redis queue ledger');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const module = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js'
    );
    ({ queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js'));
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    store = new module.RedisQueueLedgerStore(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['queue:*']);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, ['queue:*']);
  });

  function row(sourceId, targetCatId, overrides = {}) {
    return {
      version: 1,
      id: queueEntryId(sourceId, targetCatId),
      threadId: 'thread-redis',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      target: { kind: 'cat', catId: targetCatId },
      payload: { sourceId, content: sourceId, messageId: sourceId },
      execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
      delivery: {},
      status: 'queued',
      enqueuedAt: 100,
      priority: 'normal',
      ...overrides,
    };
  }

  it('round-trips fan-out rows in stable order and rejects conflicting replay', async () => {
    const rows = [row('m1', 'opus'), row('m1', 'codex')];
    assert.equal((await store.enqueue(rows, 5)).outcome, 'enqueued');
    assert.equal((await store.enqueue(rows, 5)).outcome, 'replayed');
    assert.equal((await store.enqueue([{ ...rows[0], priority: 'urgent' }, rows[1]], 5)).outcome, 'conflict');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.target.catId),
      ['opus', 'codex'],
    );
  });

  it('claims and restores without changing Redis list order', async () => {
    const first = row('m1', 'opus');
    const second = row('m2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    assert.equal((await store.claim('thread-redis', first.id, 'claim-1', 200)).outcome, 'claimed');
    assert.equal((await store.restore('thread-redis', first.id, 'stale')).outcome, 'state_changed');
    assert.equal((await store.restore('thread-redis', first.id, 'claim-1')).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.id),
      [first.id, second.id],
    );
  });

  it('binds a targetless row in the same atomic claim', async () => {
    const targetless = row('m1', 'placeholder', {
      id: queueEntryId('m1'),
      target: { kind: 'unassigned' },
    });
    await store.enqueue([targetless]);
    const claimed = await store.claim('thread-redis', targetless.id, 'claim-targetless', 200, 'codex');
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].target, { kind: 'cat', catId: 'codex' });
  });

  it('claims prefixes all-or-nothing and commits processing to terminal removal', async () => {
    const first = row('m1', 'opus');
    const second = row('m2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    const claimed = await store.claimPrefix('thread-redis', [first.id, second.id], 'batch-1', 200);
    assert.equal(claimed.outcome, 'claimed');
    assert.equal((await store.commit('thread-redis', first.id, 'batch-1', 'processing', 201)).outcome, 'updated');
    assert.equal((await store.commit('thread-redis', first.id, '', 'terminal', 300)).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => [entry.id, entry.status]),
      [[second.id, 'claimed']],
    );
  });
});
