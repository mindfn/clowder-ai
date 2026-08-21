import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = `m0c-snapshot-test-${process.pid}:`;

describe('M0-C Redis snapshot cursor', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'M0CRedisSnapshot');
    const [{ RedisCursorStore }, { createRedisClient }] = await Promise.all([
      import('../dist/domains/messaging/stores/redis.js'),
      import('@cat-cafe/shared/utils'),
    ]);
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    store = new RedisCursorStore(redis);
  });

  after(async () => {
    if (redis) await redis.quit();
  });

  it('freezes one view and atomically advances both cursor watermarks on final ack', async () => {
    const subscriptionId = `sub-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId: `handle-${Date.now()}`,
      threadId: 'thread-1',
      ackedSequence: 3,
      lastDeliveredSequence: 4,
    });
    const first = {
      snapshotId: `snap-${Date.now()}`,
      headSequence: 11,
      items: [],
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    };
    const competing = { ...first, snapshotId: `${first.snapshotId}-competing`, headSequence: 12 };

    assert.deepEqual(await store.createOrGetSnapshot('inst-a', subscriptionId, first), first);
    assert.deepEqual(await store.createOrGetSnapshot('inst-a', subscriptionId, competing), first);
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, competing.snapshotId, 12), 'rejected');
    const unchanged = await store.get('inst-a', subscriptionId);
    assert.deepEqual(
      { ackedSequence: unchanged.ackedSequence, lastDeliveredSequence: unchanged.lastDeliveredSequence },
      { ackedSequence: 3, lastDeliveredSequence: 4 },
    );

    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0, tokenId: 'forged' },
        { offset: 0, traversalComplete: true },
      ),
      false,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0 },
        { offset: 0, tokenId: 'page-2', traversalComplete: false },
      ),
      true,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0 },
        { offset: 0, traversalComplete: true },
      ),
      false,
    );
    assert.equal(
      await store.consumeSnapshotPage(
        'inst-a',
        subscriptionId,
        first.snapshotId,
        { offset: 0, tokenId: 'page-2' },
        { offset: 0, traversalComplete: true },
      ),
      true,
    );
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, first.snapshotId, 11), 'applied');
    const settled = await store.get('inst-a', subscriptionId);
    assert.equal(settled.ackedSequence, 11);
    assert.equal(settled.lastDeliveredSequence, 11);
    assert.equal(settled.snapshotView, undefined);
    assert.deepEqual(settled.lastSnapshotCompletion, { snapshotId: first.snapshotId, headSequence: 11 });
    assert.equal(await store.ackSnapshot('inst-a', subscriptionId, first.snapshotId, 11), 'replayed');
  });

  it('keeps snapshot projections out of the durable subscription identity during revocation', async () => {
    const subscriptionId = `sub-revoke-${Date.now()}`;
    const handleId = `handle-revoke-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId,
      threadId: 'thread-1',
      ackedSequence: 3,
      lastDeliveredSequence: 4,
    });
    await store.createOrGetSnapshot('inst-a', subscriptionId, {
      snapshotId: `snap-revoke-${Date.now()}`,
      headSequence: 11,
      items: [],
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    });

    assert.equal(await store.revokeByHandle(handleId, 12), 1);
    const raw = await redis.get(`plugmsg:sub:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`);
    const persisted = JSON.parse(raw);
    assert.equal(persisted.snapshotView, undefined);
    assert.equal(persisted.lastSnapshotCompletion, undefined);
    assert.equal(persisted.revokedAt, 12);
  });

  it('stores frozen snapshot items outside the cursor state and reads only the requested page', async () => {
    const subscriptionId = `sub-items-${Date.now()}`;
    await store.put({
      subscriptionId,
      pluginInstanceId: 'inst-a',
      handleId: `handle-items-${Date.now()}`,
      threadId: 'thread-1',
      ackedSequence: 0,
      lastDeliveredSequence: 0,
    });
    const items = [
      {
        messageId: 'message-1',
        revision: 1,
        threadId: 'thread-1',
        actor: { kind: 'plugin', id: 'inst-a' },
        audience: { kind: 'public' },
        occurredAt: '2026-08-21T01:00:00.000Z',
        payload: {
          provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
          elements: [{ elementId: 'element-1', kind: 'text', payload: { text: 'hello' } }],
        },
      },
    ];
    const snapshot = {
      snapshotId: `snap-items-${Date.now()}`,
      headSequence: 1,
      items,
      createdAt: 1,
      nextOffset: 0,
      traversalComplete: false,
    };

    const created = await store.createOrGetSnapshot('inst-a', subscriptionId, snapshot);
    assert.equal(created.itemCount, 1);
    assert.equal(created.items, undefined);
    const rawState = await redis.get(
      `plugmsg:subsnap:${encodeURIComponent('inst-a')}:${encodeURIComponent(subscriptionId)}`,
    );
    assert.equal(
      Object.hasOwn(JSON.parse(rawState), 'items'),
      false,
      'cursor Lua must not decode the entire frozen view',
    );
    assert.deepEqual(await store.readSnapshotPage('inst-a', subscriptionId, snapshot.snapshotId, 0, 1), items);
  });
});
