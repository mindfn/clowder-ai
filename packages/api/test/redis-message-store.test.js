/**
 * RedisMessageStore tests
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisMessageStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = storeModule.RedisMessageStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    // Connectivity check: skip all tests if Redis is unreachable
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-message-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'routing-fact:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'routing-fact:*']);
  });

  it('append() stores message and returns with id', async () => {
    const msg = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'user1',
      catId: null,
      content: 'hello',
      mentions: ['opus'],
      timestamp: Date.now(),
    });
    assert.ok(msg.id);
    assert.equal(msg.content, 'hello');
    assert.equal(msg.userId, 'user1');
  });

  it('claimContentDedupKey() is atomic: first wins, live duplicate loses, distinct keys independent', async () => {
    const first = await store.claimContentDedupKey('fp-abc', 5000);
    assert.equal(first, true, 'first claim of a fingerprint succeeds');
    const second = await store.claimContentDedupKey('fp-abc', 5000);
    assert.equal(second, false, 'a still-live claim of the same fingerprint is reported as duplicate');
    const other = await store.claimContentDedupKey('fp-xyz', 5000);
    assert.equal(other, true, 'a different fingerprint is independent');
  });

  it('claimContentDedupKey() re-allows a fingerprint after the PX window expires', async () => {
    const first = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(first, true);
    const immediate = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(immediate, false, 'within window → duplicate');
    await new Promise((resolve) => setTimeout(resolve, 90)); // wait past the PX TTL
    const afterExpiry = await store.claimContentDedupKey('fp-ttl', 40);
    assert.equal(afterExpiry, true, 'after Redis PX expiry the fingerprint can be claimed again');
  });

  it('getRecent() returns messages in chronological order', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'first',
      mentions: [],
      timestamp: now,
    });
    await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: 'second',
      mentions: [],
      timestamp: now + 1,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'third',
      mentions: [],
      timestamp: now + 2,
    });

    const recent = await store.getRecent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].content, 'first');
    assert.equal(recent[2].content, 'third');
  });

  it('getRecent() filters by userId', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'alice',
      catId: null,
      content: 'alice msg',
      mentions: [],
      timestamp: now,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'bob',
      catId: null,
      content: 'bob msg',
      mentions: [],
      timestamp: now + 1,
    });

    const aliceOnly = await store.getRecent(10, 'alice');
    assert.equal(aliceOnly.length, 1);
    assert.equal(aliceOnly[0].content, 'alice msg');
  });

  it('getMentionsFor() returns messages mentioning a specific cat', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'hi opus',
      mentions: ['opus'],
      timestamp: now,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'hi codex',
      mentions: ['codex'],
      timestamp: now + 1,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'hi both',
      mentions: ['opus', 'codex'],
      timestamp: now + 2,
    });

    const opusMentions = await store.getMentionsFor('opus');
    assert.equal(opusMentions.length, 2);
    assert.equal(opusMentions[0].content, 'hi opus');
    assert.equal(opusMentions[1].content, 'hi both');
  });

  it('getMentionsFor() filters by threadId (#75)', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: '@opus in tA',
      mentions: ['opus'],
      timestamp: now,
      threadId: 'thread-A',
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: '@opus in tB',
      mentions: ['opus'],
      timestamp: now + 1,
      threadId: 'thread-B',
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: '@opus in tA again',
      mentions: ['opus'],
      timestamp: now + 2,
      threadId: 'thread-A',
    });

    const threadA = await store.getMentionsFor('opus', 10, undefined, 'thread-A');
    assert.equal(threadA.length, 2);
    assert.equal(threadA[0].content, '@opus in tA');
    assert.equal(threadA[1].content, '@opus in tA again');

    // Without threadId returns all
    const all = await store.getMentionsFor('opus', 10);
    assert.equal(all.length, 3);
  });

  it('getBefore() returns messages before timestamp', async () => {
    const base = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'old',
      mentions: [],
      timestamp: base,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'mid',
      mentions: [],
      timestamp: base + 100,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'new',
      mentions: [],
      timestamp: base + 200,
    });

    const before = await store.getBefore(base + 200, 10);
    assert.equal(before.length, 2);
    assert.equal(before[0].content, 'old');
    assert.equal(before[1].content, 'mid');
  });

  it('getBefore() respects limit', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await store.append({
        provenance: { author: 'user', routed: false, observation: 'original' },
        userId: 'u',
        catId: null,
        content: `msg${i}`,
        mentions: [],
        timestamp: base + i,
      });
    }

    const before = await store.getBefore(base + 5, 2);
    assert.equal(before.length, 2);
    // Should get the 2 most recent before the cursor
    assert.equal(before[0].content, 'msg3');
    assert.equal(before[1].content, 'msg4');
  });

  it('augmentStreamMetadata() persists stream-only metadata onto callback messages', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: 'callback canonical',
      mentions: [],
      timestamp: Date.now(),
      origin: 'callback',
      extra: { rich: { v: 1, blocks: [{ id: 'callback-card', kind: 'card', v: 1, title: 'Callback' }] } },
    });

    await store.augmentStreamMetadata(msg.id, {
      thinking: 'stream thinking',
      metadata: { provider: 'mock', model: 'test' },
      toolEvents: [{ id: 'te-1', type: 'tool_result', label: 'post_message ok', timestamp: Date.now() }],
      mentionsUser: true,
      extra: {
        stream: { invocationId: 'parent-inv' },
        tracing: { traceId: 'trace-1', spanId: 'span-1' },
        rich: { v: 1, blocks: [{ id: 'stream-card', kind: 'card', v: 1, title: 'Stream' }] },
      },
    });

    const refetched = await store.getById(msg.id);
    assert.equal(refetched.content, 'callback canonical');
    assert.equal(refetched.origin, 'callback');
    assert.equal(refetched.thinking, 'stream thinking');
    assert.deepEqual(refetched.metadata, { provider: 'mock', model: 'test' });
    assert.equal(refetched.toolEvents.length, 1);
    assert.equal(refetched.mentionsUser, true);
    assert.deepEqual(refetched.extra.stream, { invocationId: 'parent-inv' });
    assert.deepEqual(refetched.extra.tracing, { traceId: 'trace-1', spanId: 'span-1' });
    assert.deepEqual(
      refetched.extra.rich.blocks.map((block) => block.id),
      ['callback-card', 'stream-card'],
    );
  });

  it('hardDelete clears toolEvents from returned object and Redis', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: 'tool msg',
      mentions: [],
      timestamp: Date.now(),
      toolEvents: [
        { id: 'te-1', type: 'tool_use', label: 'opus → read', timestamp: Date.now() },
        { id: 'te-2', type: 'tool_result', label: 'opus ← result', detail: 'ok', timestamp: Date.now() },
      ],
    });
    // Verify toolEvents were stored
    const before = await store.getById(msg.id);
    assert.equal(before.toolEvents.length, 2);

    // hardDelete should clear toolEvents
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.toolEvents, undefined, 'returned object should not carry toolEvents');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.toolEvents, undefined, 'Redis should not return toolEvents after hardDelete');
  });

  it('hardDelete clears thinking from returned object and Redis (F045 security)', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: 'response with thinking',
      mentions: [],
      timestamp: Date.now(),
      thinking: 'secret extended reasoning that must not survive hard delete',
    });
    // Verify thinking was stored
    const before = await store.getById(msg.id);
    assert.equal(before.thinking, 'secret extended reasoning that must not survive hard delete');

    // hardDelete should clear thinking
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    assert.equal(deleted.thinking, undefined, 'returned object should not carry thinking');
    assert.equal(deleted._tombstone, true);

    // Re-fetch from Redis to confirm thinking is gone
    const refetched = await store.getById(msg.id);
    assert.equal(refetched.thinking, undefined, 'Redis should not return thinking after hardDelete');
  });

  it('R8: hardDelete removes token-bearing F257 fields from returned object and Redis', async () => {
    const routingFact = {
      parserMode: 'user',
      spanBasis: 'lowercased_message',
      attempts: [
        { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
      ],
      truncated: false,
      metricEligible: true,
    };
    const msg = await store.append({
      provenance: { author: 'user', routed: true, observation: 'original' },
      routingFact,
      userId: 'u',
      catId: null,
      content: '@opus private request',
      mentions: ['opus'],
      timestamp: Date.now(),
    });

    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.equal(deleted.routingFact, undefined);
    assert.equal(deleted.provenance, undefined);
    assert.equal(await redis.hget(`msg:${msg.id}`, 'routingFact'), null);
    assert.equal(await redis.hget(`msg:${msg.id}`, 'provenance'), null);
  });

  it('R9: deleteByThread fences empty threads and converges orphan index members', async () => {
    const calls = [];
    const deletionStore = new RedisMessageStore(redis, {
      ttlSeconds: 60,
      onBeforeDeleteByThread: (threadId) => calls.push(threadId),
    });

    assert.equal(await deletionStore.deleteByThread('thread-empty-delete'), 0);
    assert.deepEqual(calls, ['thread-empty-delete'], 'empty physical delete still executes the terminal scrub hook');

    const threadId = 'thread-orphan-delete';
    const orphanId = 'orphan-message-id';
    const score = Date.now();
    await redis.zadd(`msg:thread:${threadId}`, String(score), orphanId);
    await redis.zadd('msg:timeline', String(score), orphanId);
    await redis.zadd('msg:user:orphan-owner', String(score), orphanId);
    await redis.zadd('msg:mentions:opus', String(score), orphanId);
    await redis.zadd('routing-fact:idx:orphan-owner', String(score), orphanId);
    await redis.zadd('routing-fact:proj-errors:orphan-owner', String(score), orphanId);

    assert.equal(await deletionStore.deleteByThread(threadId), 1);
    assert.equal(await redis.zscore(`msg:thread:${threadId}`, orphanId), null);
    assert.equal(await redis.zscore('msg:timeline', orphanId), null);
    assert.equal(await redis.zscore('msg:user:orphan-owner', orphanId), null);
    assert.equal(await redis.zscore('msg:mentions:opus', orphanId), null);
    assert.equal(await redis.zscore('routing-fact:idx:orphan-owner', orphanId), null);
    assert.equal(await redis.zscore('routing-fact:proj-errors:orphan-owner', orphanId), null);
    assert.deepEqual(calls, ['thread-empty-delete', threadId]);

    const hiddenThreadId = 'thread-hidden-authority-delete';
    const hidden = await deletionStore.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'hidden-owner',
      catId: null,
      content: 'authority hash not present in its thread index',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: hiddenThreadId,
      idempotencyKey: 'hidden-authority-idem',
    });
    await redis.zrem(`msg:thread:${hiddenThreadId}`, hidden.id);
    assert.equal(await deletionStore.deleteByThread(hiddenThreadId), 1, 'authority hash scan closes sparse index gaps');
    assert.equal(await redis.exists(`msg:${hidden.id}`), 0);
    assert.equal(await redis.zscore('msg:user:hidden-owner', hidden.id), null);
    assert.equal(await redis.zscore('msg:mentions:codex', hidden.id), null);
    assert.equal(await redis.get(`msg:idem:hidden-owner:${hiddenThreadId}:hidden-authority-idem`), null);
    assert.deepEqual(calls, ['thread-empty-delete', threadId, hiddenThreadId]);

    const retryThreadId = 'thread-physical-cleanup-retry';
    const retryMessage = await deletionStore.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'physical-retry-owner',
      catId: null,
      content: 'retain discovery anchor until sibling cleanup succeeds',
      mentions: [],
      timestamp: Date.now(),
      threadId: retryThreadId,
    });
    await redis.zrem(`msg:thread:${retryThreadId}`, retryMessage.id);
    assert.equal(
      await redis.zscore(`msg:thread:${retryThreadId}`, retryMessage.id),
      null,
      'authority scan, not a healthy thread index, must discover the message',
    );
    const corruptIndexKey = 'routing-fact:idx:wrong-type-owner';
    await redis.set(corruptIndexKey, 'wrong-type');
    await assert.rejects(() => deletionStore.deleteByThread(retryThreadId), /WRONGTYPE/);
    assert.equal(await redis.exists(`msg:${retryMessage.id}`), 0, 'authority transition stays privacy-first');
    assert.ok(
      await redis.zscore(`msg:thread:${retryThreadId}`, retryMessage.id),
      'thread member remains as the retry discovery anchor',
    );
    await redis.del(corruptIndexKey);
    assert.equal(await deletionStore.deleteByThread(retryThreadId), 1);
    assert.equal(await redis.zscore(`msg:thread:${retryThreadId}`, retryMessage.id), null);
  });

  it('R9: restore cannot clear deletion markers after concurrent hard delete linearizes', async () => {
    const msg = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'restore-race-owner',
      catId: null,
      content: 'restore race',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'restore-race-thread',
    });
    await store.softDelete(msg.id, 'restore-race-owner');

    const originalGetById = store.getById.bind(store);
    let firstRead = true;
    let announceRestoreRead;
    let releaseRestoreRead;
    const restoreRead = new Promise((resolve) => {
      announceRestoreRead = resolve;
    });
    const restoreRelease = new Promise((resolve) => {
      releaseRestoreRead = resolve;
    });
    store.getById = async (id) => {
      const value = await originalGetById(id);
      if (firstRead) {
        firstRead = false;
        announceRestoreRead();
        await restoreRelease;
      }
      return value;
    };

    try {
      const restorePromise = store.restore(msg.id);
      await restoreRead;
      const hardDeleted = await store.hardDelete(msg.id, 'admin');
      assert.equal(hardDeleted._tombstone, true);
      releaseRestoreRead();
      assert.equal(await restorePromise, null, 'restore loses once hard delete has linearized');
    } finally {
      store.getById = originalGetById;
    }

    const raw = await redis.hmget(`msg:${msg.id}`, '_tombstone', 'deletedAt', 'deletedBy');
    assert.equal(raw[0], '1');
    assert.ok(raw[1]);
    assert.equal(raw[2], 'admin');
  });

  it('R10: hard tombstones reject every Redis authority mutator without changing bytes or indexes', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'terminal-owner',
      catId: 'opus',
      content: 'sensitive payload',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-r10-terminal',
      visibility: 'whisper',
      deliveryStatus: 'queued',
      extra: { stream: { invocationId: 'old-invocation' } },
      thinking: 'sensitive thinking',
    });
    const deleted = await store.hardDelete(msg.id, 'admin');
    assert.ok(deleted);
    const rawBefore = await redis.hgetall(`msg:${msg.id}`);

    const results = {
      softDelete: await store.softDelete(msg.id, 'other-admin'),
      restore: await store.restore(msg.id),
      hardDelete: await store.hardDelete(msg.id, 'other-admin'),
      updateExtra: await store.updateExtra(msg.id, { tracing: { traceId: 'revived', spanId: 'revived' } }),
      augment: await store.augmentStreamMetadata(msg.id, {
        thinking: 'revived thinking',
        toolEvents: [{ id: 'revived-tool', type: 'tool_use', label: 'revived', timestamp: Date.now() }],
      }),
      delivered: await store.markDelivered(msg.id, Date.now() + 100),
      canceled: await store.markCanceled(msg.id),
      reassigned: await store.reassignUserId(msg.id, 'revived-owner'),
      revealed: await store.revealWhispers(msg.threadId, msg.userId),
    };

    assert.deepEqual(results, {
      softDelete: null,
      restore: null,
      hardDelete: null,
      updateExtra: null,
      augment: null,
      delivered: null,
      canceled: null,
      reassigned: null,
      revealed: 0,
    });
    assert.deepEqual(await redis.hgetall(`msg:${msg.id}`), rawBefore, 'terminal tombstone bytes remain unchanged');
    assert.equal(await redis.zscore('msg:user:revived-owner', msg.id), null);

    await redis.zadd('routing-fact:idx:historic-owner', msg.timestamp, msg.id);
    await redis.zadd('routing-fact:proj-errors:historic-owner', Date.now(), msg.id);
    assert.equal(await store.hardDelete(msg.id, 'cleanup-retry'), null, 'repeated hard delete remains a no-op');
    assert.equal(
      await redis.zscore('routing-fact:idx:historic-owner', msg.id),
      null,
      'cleanup retry removes a projection stranded under a historic owner',
    );
    assert.equal(
      await redis.zscore('routing-fact:proj-errors:historic-owner', msg.id),
      null,
      'cleanup retry removes a historic-owner projection error',
    );
  });

  it('R10: a stale payload writer cannot recreate data after hard delete linearizes', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'stale-payload-owner',
      catId: 'opus',
      content: 'sensitive payload',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-r10-stale-payload',
      extra: { stream: { invocationId: 'old-invocation' } },
    });

    const originalGetById = store.getById.bind(store);
    let firstRead = true;
    let announcePayloadRead;
    let releasePayloadRead;
    const payloadRead = new Promise((resolve) => {
      announcePayloadRead = resolve;
    });
    const payloadRelease = new Promise((resolve) => {
      releasePayloadRead = resolve;
    });
    store.getById = async (id) => {
      const value = await originalGetById(id);
      if (firstRead) {
        firstRead = false;
        announcePayloadRead();
        await payloadRelease;
      }
      return value;
    };

    try {
      const staleWrite = store.updateExtra(msg.id, { tracing: { traceId: 'revived', spanId: 'revived' } });
      await payloadRead;
      const hardDeleted = await store.hardDelete(msg.id, 'admin');
      assert.equal(hardDeleted._tombstone, true);
      releasePayloadRead();
      assert.equal(await staleWrite, null, 'writer loses once hard delete has linearized');
    } finally {
      store.getById = originalGetById;
    }

    const raw = await redis.hmget(`msg:${msg.id}`, '_tombstone', 'extra', 'thinking', 'toolEvents');
    assert.deepEqual(raw, ['1', '', '', '']);
  });

  it('message TTL is set', async () => {
    const msg = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'ttl test',
      mentions: [],
      timestamp: Date.now(),
    });
    const ttl = await redis.ttl(`msg:${msg.id}`);
    assert.ok(ttl > 0, `Expected positive TTL, got ${ttl}`);
    assert.ok(ttl <= 60, `Expected TTL <= 60, got ${ttl}`);
  });

  it('append() with same idempotencyKey returns existing message', async () => {
    const first = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'kickoff',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    const second = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'kickoff retried',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-idem',
      idempotencyKey: 'backlog:b1:attempt:a1',
    });

    assert.equal(second.id, first.id);
    assert.equal(second.content, 'kickoff');

    const threadMessages = await store.getByThread('thread-idem', 10, 'u1');
    assert.equal(threadMessages.length, 1);
    assert.equal(threadMessages[0].id, first.id);
  });

  it('F057-C2: mentionsUser round-trips through append/getById', async () => {
    const msg = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: '@co-creator 看看这个',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-mention-user',
      mentionsUser: true,
    });
    assert.equal(msg.mentionsUser, true, 'append should return mentionsUser');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.mentionsUser, true, 'getById should deserialize mentionsUser');
  });

  it('F057-C2: mentionsUser round-trips through hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: '@user please check',
      mentions: [],
      timestamp: now,
      threadId: 'thread-mention-hydrate',
      mentionsUser: true,
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'normal message',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-mention-hydrate',
    });

    const msgs = await store.getByThread('thread-mention-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].mentionsUser, true, 'first message should have mentionsUser');
    assert.equal(msgs[1].mentionsUser, undefined, 'second message should not have mentionsUser');
  });

  it('markDelivered updates sorted set score to deliveredAt (#557)', async () => {
    const base = Date.now();
    const threadId = 'thread-score-deliver-557';

    // msgA sent first (base), msgB sent second (base+100) — both queued
    const msgA = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'msgA-sent-first',
      mentions: [],
      timestamp: base,
      threadId,
      deliveryStatus: 'queued',
    });
    const msgB = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'msgB-sent-second',
      mentions: [],
      timestamp: base + 100,
      threadId,
      deliveryStatus: 'queued',
    });

    // Deliver in REVERSE order: msgB delivered early (base+50), msgA delivered late (base+200)
    // This makes deliveredAt order diverge from send-time order.
    await store.markDelivered(msgB.id, base + 50);
    await store.markDelivered(msgA.id, base + 200);

    // With deliveredAt scoring: msgB(50) < msgA(200) — B sorts before A
    // With send-time scoring: msgA(0) < msgB(100) — A sorts before B
    // NOTE: queued messages are filtered from getByThread (isDelivered check),
    // but after markDelivered they become 'delivered' and are visible.
    const all = await store.getByThread(threadId, 10);
    const order = all.map((m) => m.id);
    const idxA = order.indexOf(msgA.id);
    const idxB = order.indexOf(msgB.id);
    assert.ok(idxA >= 0, 'msgA should be in results after delivery');
    assert.ok(idxB >= 0, 'msgB should be in results after delivery');
    assert.ok(idxB < idxA, 'msgB (deliveredAt=base+50) should sort before msgA (deliveredAt=base+200)');
  });

  it('getByThreadAfter() uses deliveredAt score for cursor position (#557)', async () => {
    const base = Date.now();
    const threadId = 'thread-cursor-deliver-557';

    // agentReply at base (simulates invocation start time) — already delivered (no deliveryStatus)
    const agentReply = await store.append({
      provenance: { author: 'cat', routed: false, observation: 'original' },
      userId: 'u',
      catId: 'opus',
      content: 'agent-reply',
      mentions: [],
      timestamp: base,
      threadId,
    });
    // queuedMsg sent BEFORE agent reply (base-10), queued — delivered AFTER (base+500).
    // Without zadd re-scoring, original timestamp (base-10) < cursor (base), so it would NOT
    // appear; only deliveredAt re-scoring (base+500 > base) makes it visible after cursor.
    const queuedMsg = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'queued-user-msg',
      mentions: [],
      timestamp: base - 10,
      threadId,
      deliveryStatus: 'queued',
    });
    await store.markDelivered(queuedMsg.id, base + 500);

    // After agent reply cursor: queuedMsg should appear only because score was updated to deliveredAt
    const after = await store.getByThreadAfter(threadId, agentReply.id);
    const ids = after.map((m) => m.id);
    assert.ok(
      ids.includes(queuedMsg.id),
      'queued msg (deliveredAt=base+500 > cursor=base) should appear after agent reply',
    );
  });

  it('F148: origin=briefing survives append → getById round-trip', async () => {
    const msg = await store.append({
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: 'system',
      catId: null,
      content: 'briefing summary',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-briefing-rt',
      origin: 'briefing',
      extra: { rich: { v: 1, blocks: [{ id: 'b1', kind: 'card', v: 1, title: 'test', tone: 'info' }] } },
    });
    assert.equal(msg.origin, 'briefing', 'append should return origin=briefing');

    const fetched = await store.getById(msg.id);
    assert.equal(fetched.origin, 'briefing', 'getById must deserialize origin=briefing');
    assert.ok(fetched.extra?.rich?.blocks?.length, 'rich blocks must survive round-trip');
  });

  it('F148: origin=briefing survives hydrateMessages (getByThread)', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: 'system',
      catId: null,
      content: 'briefing card',
      mentions: [],
      timestamp: now,
      threadId: 'thread-briefing-hydrate',
      origin: 'briefing',
    });
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u',
      catId: null,
      content: 'normal',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-briefing-hydrate',
    });

    const msgs = await store.getByThread('thread-briefing-hydrate', 10);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].origin, 'briefing', 'briefing message must keep origin via hydrateMessages');
    assert.equal(msgs[1].origin, undefined, 'normal message should have no origin');
  });

  // ── #697 + #805 review: scanByDeliveryStatus ──

  it('scanByDeliveryStatus returns IDs matching target status', async () => {
    const now = Date.now();
    // Create messages with different delivery statuses
    const m1 = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'queued msg 1',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-1',
      deliveryStatus: 'queued',
    });
    const m2 = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'delivered msg',
      mentions: [],
      timestamp: now + 1,
      threadId: 'thread-scan-1',
    });
    const m3 = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'queued msg 2',
      mentions: [],
      timestamp: now + 2,
      threadId: 'thread-scan-2',
      deliveryStatus: 'queued',
    });

    const queuedIds = await store.scanByDeliveryStatus('queued');

    // Should find both queued messages
    assert.equal(queuedIds.length, 2, 'should find exactly 2 queued messages');
    assert.ok(queuedIds.includes(m1.id), 'should include first queued message');
    assert.ok(queuedIds.includes(m3.id), 'should include second queued message');
    // Should NOT include delivered message
    assert.ok(!queuedIds.includes(m2.id), 'should not include delivered message');
  });

  it('scanByDeliveryStatus returns empty array when no matches', async () => {
    const now = Date.now();
    await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'normal msg',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-empty',
    });

    const queuedIds = await store.scanByDeliveryStatus('queued');
    assert.equal(queuedIds.length, 0);
  });

  it('scanByDeliveryStatus result order is independent of insertion order (SCAN non-deterministic)', async () => {
    const now = Date.now();
    const created = [];
    for (let i = 0; i < 5; i++) {
      const msg = await store.append({
        provenance: { author: 'user', routed: false, observation: 'original' },
        userId: 'u1',
        catId: null,
        content: `queued ${i}`,
        mentions: [],
        timestamp: now + i,
        threadId: 'thread-scan-order',
        deliveryStatus: 'queued',
      });
      created.push(msg.id);
    }

    const queuedIds = await store.scanByDeliveryStatus('queued');

    // All 5 should be found regardless of SCAN order
    assert.equal(queuedIds.length, 5);
    for (const id of created) {
      assert.ok(queuedIds.includes(id), `should include ${id}`);
    }
  });

  it('scanByDeliveryStatus finds canceled messages', async () => {
    const now = Date.now();
    const m1 = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'u1',
      catId: null,
      content: 'will be canceled',
      mentions: [],
      timestamp: now,
      threadId: 'thread-scan-cancel',
      deliveryStatus: 'queued',
    });
    await store.markCanceled(m1.id);

    const canceledIds = await store.scanByDeliveryStatus('canceled');
    assert.ok(canceledIds.includes(m1.id), 'should find canceled message');

    const queuedIds = await store.scanByDeliveryStatus('queued');
    assert.ok(!queuedIds.includes(m1.id), 'should not find canceled message in queued scan');
  });
});

describe('F257 V1: routingFact embedded authority (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let redis;
  let store;
  let connected = false;

  const SAMPLE_BATCH = {
    parserMode: 'user',
    spanBasis: 'lowercased_message',
    attempts: [
      { tokenOrdinal: 0, outcome: 'resolved', token: '@codex', span: { start: 3, end: 9 }, targetCatId: 'codex' },
      { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zzz', span: { start: 12, end: 16 } },
    ],
    truncated: false,
    metricEligible: true,
  };

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore routingFact');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    RedisMessageStore = storeModule.RedisMessageStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisMessageStore(redis, { ttlSeconds: 60 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
  });

  it('append() persists routingFact in the message hash and getById round-trips it', async () => {
    const stored = await store.append({
      userId: 'user-1',
      catId: null,
      content: '找 @codex 和 @zzz',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'th-f257',
      routingFact: SAMPLE_BATCH,
      provenance: { author: 'user', routed: true, observation: 'original' },
    });
    assert.deepEqual(stored.routingFact, SAMPLE_BATCH, 'append return value carries the fact');
    const fetched = await store.getById(stored.id);
    assert.deepEqual(fetched?.routingFact, SAMPLE_BATCH, 'getById round-trips the fact');
  });

  it('hydrate path (getByThread) round-trips routingFact', async () => {
    await store.append({
      userId: 'user-1',
      catId: null,
      content: '找 @codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'th-f257-hydrate',
      routingFact: SAMPLE_BATCH,
      provenance: { author: 'user', routed: true, observation: 'original' },
    });
    const msgs = await store.getByThread('th-f257-hydrate', 10);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].routingFact, SAMPLE_BATCH);
  });

  it('append() persists an empty-attempts batch and tolerates a malformed stored field', async () => {
    const emptyBatch = { ...SAMPLE_BATCH, attempts: [] };
    const stored = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'no tokens',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'th-f257-empty',
      routingFact: emptyBatch,
      provenance: { author: 'user', routed: true, observation: 'original' },
    });
    const fetched = await store.getById(stored.id);
    // sol R1 P1-1: zero-token batches persist — the fact field is the
    // producer-run marker the coverage cohort audits.
    assert.deepEqual(fetched?.routingFact, emptyBatch, 'empty batch persists as producer-run marker');

    // Malformed field must not break message reads (safe-parse contract)
    await redis.hset(`msg:${stored.id}`, { routingFact: '{not json' });
    const refetched = await store.getById(stored.id);
    assert.ok(refetched, 'message still readable');
    assert.equal(refetched.routingFact, undefined, 'malformed fact parses to undefined');
  });

  it('append() provenance roundtrips all three axes', async () => {
    const stored = await store.append({
      userId: 'user-lane',
      catId: null,
      content: '@opus hi',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'th-f257-lane',
      routingFact: SAMPLE_BATCH,
      provenance: { author: 'user', routed: true, observation: 'original' },
    });
    const fetched = await store.getById(stored.id);
    assert.deepEqual(fetched?.provenance, { author: 'user', routed: true, observation: 'original' });

    // sol R4 P1-1b: a declaration-less append no longer exists — the write
    // boundary rejects it outright (uncompiled callers included)
    await assert.rejects(
      store.append({
        userId: 'user-lane',
        catId: null,
        content: 'card',
        mentions: [],
        timestamp: Date.now(),
        threadId: 'th-f257-lane',
      }),
      /append requires provenance/,
    );

    // absent-field rows (written before the contract) still hydrate as
    // "no trusted declaration" — out of every cohort
    const surface = await store.append({
      provenance: { author: 'user', routed: false, observation: 'original' },
      userId: 'user-lane',
      catId: null,
      content: 'card',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'th-f257-lane',
    });
    await redis.hdel(`msg:${surface.id}`, 'provenance');
    assert.equal(
      (await store.getById(surface.id))?.provenance,
      undefined,
      'absent field = legacy pre-contract row — no trusted declaration',
    );
  });

  it('append() surfaces per-command MULTI errors and undoes partial writes (sol R2 P1-3)', async () => {
    const userId = 'user-exec-err';
    // Break the user timeline key type so the pipeline's ZADD fails per-command
    await redis.set(`msg:user:${userId}`, 'wrong-type');

    await assert.rejects(
      () =>
        store.append({
          userId,
          catId: null,
          content: '@opus 看下',
          mentions: ['opus'],
          timestamp: Date.now(),
          threadId: 'th-f257-execerr',
          routingFact: SAMPLE_BATCH,
          provenance: { author: 'user', routed: true, observation: 'original' },
          idempotencyKey: 'exec-err-1',
        }),
      /WRONGTYPE|wrong kind/i,
      'append must not report success over a failed index write',
    );

    // Partial-execution cleanup: no orphan hash, no ghost thread-timeline entry,
    // and the idempotency claim is rolled back.
    const threadIds = await redis.zrange('msg:thread:th-f257-execerr', 0, -1);
    assert.deepEqual(threadIds, [], 'thread timeline must not keep a ghost entry');
    const globalIds = await redis.zrange('msg:timeline', 0, -1);
    for (const id of globalIds) {
      const hash = await redis.hgetall(`msg:${id}`);
      assert.notEqual(hash.threadId, 'th-f257-execerr', 'no orphan hash for the failed append');
    }
    assert.equal(
      await redis.get('msg:idem:user-exec-err:th-f257-execerr:exec-err-1'),
      null,
      'idempotency claim rolled back',
    );

    // After the operator repairs the key, the same append succeeds cleanly.
    await redis.del(`msg:user:${userId}`);
    const ok = await store.append({
      userId,
      catId: null,
      content: '@opus 看下',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'th-f257-execerr',
      routingFact: SAMPLE_BATCH,
      provenance: { author: 'user', routed: true, observation: 'original' },
      idempotencyKey: 'exec-err-1',
    });
    assert.ok(ok.id, 'append succeeds after repair with the same idempotency key');
  });
});
