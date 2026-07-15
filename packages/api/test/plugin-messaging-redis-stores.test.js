/**
 * K-1 / F258 — Redis store implementations (plan Task 8)
 * Mirrors the memory-impl assertion matrix against real Redis.
 * Runs only under the isolated Redis runner (pnpm --filter @cat-cafe/api test:redis);
 * skipped in the default suite. Unique keyPrefix — no wildcard cleanup (per LL in
 * ball-custody-ingest-redis.test.js).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `f258-plugmsg-test-${process.pid}:`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Plugin messaging Redis stores', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connected = false;
  let RedisLedgerStore;
  let RedisHandleStore;
  let RedisEventLogStore;
  let RedisCursorStore;
  let RedisAppendLock;

  let seq = 0;
  const nextId = (prefix) => `${prefix}-${Date.now()}-${(seq += 1)}`;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'PluginMessagingRedis');
    ({ RedisLedgerStore, RedisHandleStore, RedisEventLogStore, RedisCursorStore, RedisAppendLock } = await import(
      '../dist/domains/messaging/stores/redis.js'
    ));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    connected = true;
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  function publishInput(threadId, messageId) {
    return {
      eventId: `ev-${messageId}`,
      type: 'message.publish',
      envelope: {
        messageId,
        revision: 1,
        threadId,
        actor: { kind: 'plugin', id: 'inst-a' },
        audience: { kind: 'public' },
        occurredAt: '2026-07-15T00:00:00.000Z',
        payload: {
          provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
        },
      },
    };
  }

  describe('RedisLedgerStore (§4a)', () => {
    it('unclaimed → new; concurrent → inflight; settle → settled with same receipt', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      assert.deepEqual(await store.claim(key, 60_000), { status: 'new' });
      assert.deepEqual(await store.claim(key, 60_000), { status: 'inflight' });
      await store.settle(key, { messageId: 'm-1', revision: 1 }, 60_000);
      const settled = await store.claim(key, 60_000);
      assert.equal(settled.status, 'settled');
      assert.deepEqual(settled.receipt, { messageId: 'm-1', revision: 1 });
    });

    it('settle keeps the first receipt (sticky)', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      await store.claim(key, 60_000);
      await store.settle(key, { messageId: 'first' }, 60_000);
      await store.settle(key, { messageId: 'second' }, 60_000);
      assert.deepEqual((await store.claim(key, 60_000)).receipt, { messageId: 'first' });
    });

    it('release returns inflight to unclaimed but never erases settled', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      await store.claim(key, 60_000);
      await store.release(key);
      assert.deepEqual(await store.claim(key, 60_000), { status: 'new' });
      await store.settle(key, { messageId: 'm' }, 60_000);
      await store.release(key);
      assert.equal((await store.claim(key, 60_000)).status, 'settled');
    });

    it('claim TTL expiry frees a crashed claim (PX semantics)', async () => {
      const store = new RedisLedgerStore(redis);
      const key = nextId('ledger');
      await store.claim(key, 80);
      await sleep(140);
      assert.deepEqual(await store.claim(key, 60_000), { status: 'new' });
    });
  });

  describe('RedisEventLogStore (INV-3, D-3)', () => {
    it('assigns monotonic per-thread sequences; threads independent', async () => {
      const store = new RedisEventLogStore(redis);
      const t1 = nextId('thread');
      const t2 = nextId('thread');
      const r1 = await store.append(t1, 'k1', publishInput(t1, 'm1'), 100);
      const r2 = await store.append(t1, 'k2', publishInput(t1, 'm2'), 100);
      const o1 = await store.append(t2, 'k1', publishInput(t2, 'm1'), 100);
      assert.deepEqual([r1.sequence, r2.sequence, o1.sequence], [1, 2, 1]);
      const events = await store.readAfter(t1, 0, 10);
      assert.deepEqual(
        events.map((e) => e.sequence),
        [1, 2],
      );
      assert.equal(events[0].envelope.messageId, 'm1');
    });

    it('same eventKey dedupes to original sequence within window', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      const first = await store.append(t, 'pub:m1:1', publishInput(t, 'm1'), 100);
      const retry = await store.append(t, 'pub:m1:1', publishInput(t, 'm1'), 100);
      assert.deepEqual([retry.deduped, retry.sequence], [true, first.sequence]);
      assert.equal((await store.readAfter(t, 0, 10)).length, 1);
    });

    it('trim drops oldest, floor rises, head keeps counting; trimmed key re-appends fresh', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      await store.append(t, 'kX', publishInput(t, 'mX'), 3);
      for (let i = 1; i <= 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await store.append(t, `k${i}`, publishInput(t, `m${i}`), 3);
      }
      assert.equal(await store.headSequence(t), 5);
      assert.equal(await store.minSequence(t), 3);
      const again = await store.append(t, 'kX', publishInput(t, 'mX'), 3);
      assert.deepEqual([again.deduped, again.sequence], [false, 6]);
    });

    it('eventKey containing | is stored and trimmed safely', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      const weird = 'append:m1:op|with|pipes';
      const first = await store.append(t, weird, publishInput(t, 'm1'), 100);
      const retry = await store.append(t, weird, publishInput(t, 'm1'), 100);
      assert.deepEqual([retry.deduped, retry.sequence], [true, first.sequence]);
    });

    it('empty thread: floor null, head 0', async () => {
      const store = new RedisEventLogStore(redis);
      const t = nextId('thread');
      assert.equal(await store.minSequence(t), null);
      assert.equal(await store.headSequence(t), 0);
    });
  });

  describe('RedisHandleStore + RedisCursorStore (§4c cascade)', () => {
    it('handle roundtrip + idempotent revoke', async () => {
      const store = new RedisHandleStore(redis);
      const handleId = nextId('th_handle');
      await store.put({
        handleId,
        kind: 'thread_handle',
        pluginInstanceId: 'inst-a',
        threadId: 'thread-1',
        userId: 'user-1',
        scope: { canSend: true, canSubscribe: true },
        issuedAt: 1,
      });
      const loaded = await store.get(handleId);
      assert.equal(loaded.threadId, 'thread-1');
      assert.equal(loaded.revokedAt, undefined);
      assert.equal(await store.revoke(handleId, 42), true);
      assert.equal((await store.get(handleId)).revokedAt, 42);
      assert.equal(await store.revoke(handleId, 99), true);
      assert.equal((await store.get(handleId)).revokedAt, 42, 'first revocation timestamp sticks');
      assert.equal(await store.revoke(nextId('missing'), 1), false);
    });

    it('subscription roundtrip, monotonic advances, findByHandle, revoke cascade', async () => {
      const store = new RedisCursorStore(redis);
      const handleId = nextId('th_handle');
      const subscriptionId = nextId('sub');
      await store.put({
        subscriptionId,
        pluginInstanceId: 'inst-a',
        handleId,
        threadId: 'thread-1',
        ackedSequence: 5,
        lastDeliveredSequence: 5,
      });

      const found = await store.findByHandle('inst-a', handleId);
      assert.equal(found.subscriptionId, subscriptionId);
      assert.equal(await store.findByHandle('inst-b', handleId), null);

      await store.advanceAck('inst-a', subscriptionId, 9);
      await store.advanceAck('inst-a', subscriptionId, 7); // regress attempt
      await store.advanceDelivered('inst-a', subscriptionId, 12);
      const loaded = await store.get('inst-a', subscriptionId);
      assert.equal(loaded.ackedSequence, 9, 'ack is monotonic max');
      assert.equal(loaded.lastDeliveredSequence, 12);

      const revoked = await store.revokeByHandle(handleId, 77);
      assert.equal(revoked, 1);
      assert.ok((await store.get('inst-a', subscriptionId)).revokedAt);
      assert.equal(await store.findByHandle('inst-a', handleId), null, 'live lookup excludes revoked');
    });
  });

  describe('RedisAppendLock (§4d)', () => {
    it('acquire/contend/release/TTL-expiry', async () => {
      const lock = new RedisAppendLock(redis);
      const messageId = nextId('msg');
      assert.equal(await lock.acquire(messageId, 60_000), true);
      assert.equal(await lock.acquire(messageId, 60_000), false);
      await lock.release(messageId);
      assert.equal(await lock.acquire(messageId, 80), true);
      await sleep(140);
      assert.equal(await lock.acquire(messageId, 60_000), true, 'expired lock is acquirable');
    });

    it('release only frees own token (stale holder cannot release the new lock)', async () => {
      const lockA = new RedisAppendLock(redis);
      const lockB = new RedisAppendLock(redis);
      const messageId = nextId('msg');
      assert.equal(await lockA.acquire(messageId, 60), true);
      await sleep(120); // A's lock expired
      assert.equal(await lockB.acquire(messageId, 60_000), true);
      await lockA.release(messageId); // stale release must not free B's lock
      assert.equal(await lockA.acquire(messageId, 60_000), false, "B's lock survives A's stale release");
    });
  });
});
