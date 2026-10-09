import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisCommunityObjectStore } from '../dist/domains/community/CommunityObjectStore.js';
import { CommunityKeys } from '../dist/domains/community/community-keys.js';
import { communityObjectReadView } from '../dist/routes/community-read-identity.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

// Real Redis values and Lua execution; only SMEMBERS ordering is forced to exercise both orders.
for (const reversed of [false, true]) {
  for (const mode of ['aliases', 'canonical', 'concurrent-canonical', 'stale-index']) {
    test(
      `projection alias selection: ${mode}, reversed=${reversed}`,
      {
        skip: redisIsolationSkipReason(process.env.REDIS_URL),
      },
      async (t) => {
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'projection alias selection');
        const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `projection-alias:${randomUUID()}:` });
        t.after(() => redis.quit());
        const subject = 'issue:owner/repo#1';
        const aliases = ['issue:OWNER/Repo#1', 'issue:Owner/Repo#1'];
        const projection = (key) => ({
          subjectKey: key,
          ownerThreadId: `thread:${key}`,
          state: 'fixed',
          updatedAt: 17,
        });
        for (const key of reversed ? [...aliases].reverse() : aliases) {
          if (mode !== 'stale-index' || key !== aliases[0]) {
            await redis.set(CommunityKeys.objectProjection(key), JSON.stringify(projection(key)));
          }
          await redis.sadd(CommunityKeys.objectsIndex, key);
        }
        const smembers = redis.smembers.bind(redis);
        redis.smembers = async (...args) => {
          const keys = (await smembers(...args)).sort();
          return reversed ? keys.reverse() : keys;
        };
        const store = new RedisCommunityObjectStore(redis);
        if (mode === 'canonical') await store.save(projection(subject));
        if (mode === 'concurrent-canonical') {
          const evaluate = redis.eval.bind(redis);
          redis.eval = async (...args) => {
            await store.save(projection(subject));
            return evaluate(...args);
          };
        }
        const selected = mode.includes('canonical') ? subject : mode === 'stale-index' ? aliases[1] : aliases[0];
        const result = await communityObjectReadView(store).get(subject);
        assert.deepEqual(result, { ...projection(selected), subjectKey: subject });
        assert.deepEqual(await store.get(aliases[1]), result, 'subsequent reads retain the selected canonical record');
        assert.deepEqual(JSON.parse(await redis.get(CommunityKeys.objectProjection(subject))), result);
        // Losing aliases remain available; selection does not silently merge or discard their authority.
        if (selected !== aliases[1]) {
          assert.equal(
            await redis.get(CommunityKeys.objectProjection(aliases[1])),
            JSON.stringify(projection(aliases[1])),
          );
        }
      },
    );
  }
}
