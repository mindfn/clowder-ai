import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Redis from 'ioredis';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';

test('dot request admission and connection-scoped atomic idempotency survive a Redis store restart', async () => {
  const url = process.env.REDIS_URL;
  assert.ok(url, 'run through scripts/run-isolated-redis-tests.sh');
  assertRedisIsolationOrThrow(url);
  const redis = new Redis(url);
  const owner = `dot-test-${randomUUID()}`;
  const store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  try {
    const dotAsk = {
      v: 1 as const,
      ownerUserId: owner,
      attemptId: 'attempt',
      subscriptionId: 'subscription',
      recipientCatIds: ['codex'],
      requestKey: 'request',
      requestDigest: '1'.repeat(64),
    };
    const input = {
      userId: owner,
      threadId: `${owner}:A`,
      catId: createCatId('gpt-dot'),
      content: 'question',
      mentions: [createCatId('codex')],
      timestamp: Date.now(),
      extra: { dotAsk },
      idempotencyKey: 'request',
    };
    const [a, b] = await Promise.all([
      store.appendIdempotent(input),
      store.appendIdempotent({ ...input, threadId: `${owner}:B` }),
    ]);
    assert.equal(a.message.id, b.message.id);
    assert.equal(Number(a.idempotent) + Number(b.idempotent), 1);
    const afterRestart = new RedisMessageStore(redis, { ttlSeconds: 0 });
    assert.deepEqual((await afterRestart.getById(a.message.id))?.extra?.dotAsk, dotAsk);
    assert.equal((await afterRestart.getByIdempotencyKey(owner, 'dot-ask:attempt', 'request'))?.id, a.message.id);
    await afterRestart.updateExtra(a.message.id, { dotAsk: { ...dotAsk, subscriptionId: 'forged' } } as never);
    assert.deepEqual((await afterRestart.getById(a.message.id))?.extra?.dotAsk, dotAsk);
    assert.equal(await redis.ttl(`msg:${a.message.id}`), -1, 'user-visible request has no TTL');
  } finally {
    await redis.quit();
  }
});
