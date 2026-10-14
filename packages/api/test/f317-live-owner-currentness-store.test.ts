import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { Redis } from 'ioredis';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import {
  type IMessageStore,
  MessageStore,
  type ThreadMessageReadOptions,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { isLatestOwnerMessage } from '../src/domains/concierge/live/host/voice/live-owner-currentness.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const options: ThreadMessageReadOptions & { onlyUnpositionedOwnerMessages: boolean } = {
  includeQueuedUserMessages: true,
  includeRecalledUserMessages: true,
  onlyUnpositionedOwnerMessages: true,
};

for (const backend of ['memory', 'redis'] as const)
  test(
    `${backend}: owner uncertainty is filtered before the history limit`,
    { skip: backend === 'redis' && redisIsolationSkipReason(process.env.REDIS_URL) },
    async () => {
      let redis: Redis | undefined;
      if (backend === 'redis') {
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 owner currentness');
        redis = new Redis(process.env.REDIS_URL!, {
          keyPrefix: `f317-currentness-${randomUUID()}:`,
          maxRetriesPerRequest: 1,
        });
      }
      const store: IMessageStore = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
      const scope = {
        userId: 'owner',
        threadId: 'home',
        catId: createCatId('codex61-sol'),
        callId: 'call',
        invocationId: 'inv',
        generation: 1,
      };
      try {
        for (let i = 0; i < 300; i++)
          await store.append({
            userId: 'owner',
            threadId: 'home',
            catId: createCatId('sonnet'),
            content: 'history',
            mentions: [],
            timestamp: 100 + i,
          });
        assert.deepEqual(
          await store.getByThread('home', 1, 'owner', options),
          [],
          'delivered history is not pending owner input',
        );
        const source = await store.append({
          userId: 'owner',
          threadId: 'home',
          catId: null,
          content: 'current input',
          mentions: [],
          timestamp: 1_000,
        });
        assert.equal(
          await isLatestOwnerMessage(store, scope, source),
          true,
          'long history does not revoke the current owner source',
        );
        for (let i = 0; i < 255; i++)
          await store.append({
            userId: 'owner',
            threadId: 'home',
            catId: createCatId('sonnet'),
            content: 'later assistant reply',
            mentions: [],
            timestamp: 2_000 + i,
          });
        assert.equal(
          await isLatestOwnerMessage(store, scope, source),
          true,
          '255 exclusive after-source rows are fully observed',
        );
        await store.append({
          userId: 'owner',
          threadId: 'home',
          catId: createCatId('sonnet'),
          content: '256th later reply',
          mentions: [],
          timestamp: 3_000,
        });
        assert.equal(await isLatestOwnerMessage(store, scope, source), false, '256 rows leave the next page unknown');
        const latest = await store.append({
          userId: 'owner',
          threadId: 'home',
          catId: null,
          content: 'new current input',
          mentions: [],
          timestamp: 4_000,
        });
        assert.equal(await isLatestOwnerMessage(store, scope, latest), true);
        const entry = new InvocationQueue().enqueue({
          userId: 'owner',
          threadId: 'home',
          source: 'user',
          ownerAuthProvenance: 'strict',
          content: 'correction',
          targetCats: [createCatId('codex61-sol')],
          intent: 'coordinate',
        }).entry;
        assert.ok(entry);
        const queued = await store.append({
          userId: 'owner',
          threadId: 'home',
          catId: null,
          content: 'correction',
          mentions: [],
          timestamp: 1,
          deliveryStatus: 'queued',
          queueCustody: createInitialQueuedMessageCustody(entry),
        });
        assert.equal(
          (await store.getByThread('home', 256, 'owner', { includeQueuedUserMessages: true })).some(
            (row) => row.id === queued.id,
          ),
          backend === 'memory',
          'Redis uses the backdated raw timeline',
        );
        assert.deepEqual(
          (await store.getByThread('home', 1, 'owner', options)).map((row) => row.id),
          [queued.id],
          'backdated pending input is found beyond 300 newer timeline rows',
        );
        assert.equal(
          await isLatestOwnerMessage(store, scope, latest),
          false,
          'backdated queued input still fences the latest visible source',
        );
        assert.deepEqual(await store.getByThread('home', 1, 'foreign-owner', options), []);
        assert.deepEqual(
          await store.getByThread('home', 1, undefined, options),
          [],
          'this owner-only read requires an owner',
        );
        if (redis) assert.equal(await redis.ttl(`msg:${queued.id}`), -1);
      } finally {
        if (redis) {
          await cleanupClientKeyspace(redis);
          await redis.quit();
        }
      }
    },
  );
