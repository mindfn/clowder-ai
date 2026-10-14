import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { isLatestOwnerMessage } from '../src/domains/concierge/live/host/voice/live-owner-currentness.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: 'codex61-sol',
  callId: 'call',
  invocationId: 'inv',
  generation: 1,
};
const options = {
  includeQueuedUserMessages: true,
  includeRecalledUserMessages: true,
  onlyUnpositionedOwnerMessages: true,
};
const input = {
  userId: 'owner',
  threadId: 'home',
  catId: null,
  content: 'backdated queued correction',
  mentions: [],
  timestamp: 1,
  deliveryStatus: 'queued',
  queueCustody: makeQueuedMessageCustody(),
};
for (const scenario of ['restore', 'hard-tombstone', 'hard-delete-race'])
  test('source1453 ' + scenario, { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 restore probe');
    const redis = new Redis(process.env.REDIS_URL, {
      keyPrefix: 'f317-restore-' + randomUUID() + ':',
      maxRetriesPerRequest: 1,
    });
    const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    try {
      const source = await store.append({
        ...input,
        timestamp: 9000,
        content: 'current source',
        deliveryStatus: undefined,
        queueCustody: undefined,
      });
      const queued = await store.append(input);
      await store.softDelete(queued.id, 'owner');
      assert.deepEqual(await store.getByThread('home', 1, 'owner', options), []);
      assert.equal(await isLatestOwnerMessage(store, scope, source), true);
      if (scenario === 'hard-tombstone') {
        await store.hardDelete(queued.id, 'owner');
        assert.equal(await store.restore(queued.id), null);
      } else if (scenario === 'hard-delete-race') {
        const read = store.getById.bind(store);
        let intercepted = false;
        store.getById = async (id) => {
          const value = await read(id);
          if (id === queued.id && !intercepted) {
            intercepted = true;
            await store.hardDelete(id, 'owner');
          }
          return value;
        };
        assert.equal(
          await store.restore(queued.id),
          null,
          'final restore cannot overwrite a newly hard-deleted tombstone',
        );
        assert.equal((await read(queued.id))._tombstone, true);
        assert.ok((await read(queued.id)).deletedAt);
      } else {
        const restored = await store.restore(queued.id);
        assert.equal(restored?.deletedAt, undefined);
        assert.equal((await store.getById(queued.id)).deliveryStatus, 'queued');
        assert.deepEqual(
          (await store.getByThread('home', 1, 'owner', options)).map((row) => row.id),
          [queued.id],
        );
        assert.equal(
          await isLatestOwnerMessage(store, scope, source),
          false,
          'restored pending input still fences the visible source',
        );
      }
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
