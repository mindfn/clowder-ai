import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifyPublicReplyCustody } from './f290-public-reply-custody.fixture.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

test(
  'Redis CAS persists exact public reply witnesses and refuses cross-source or wrong-scope settlement',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'f290-public-reply-custody');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisMessageStore } = await import('../src/domains/cats/services/stores/redis/RedisMessageStore.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f290-public-terminal:${randomUUID()}:` });
    try {
      await verifyPublicReplyCustody(new RedisMessageStore(redis));
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  },
);
