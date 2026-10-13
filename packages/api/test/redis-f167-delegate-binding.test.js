import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { OWNER_CAT, OWNER_THREAD, TASK_ID, TENANT } from './f167-delegate-test-helpers.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

const { ThreadDelegateBindingProvider } = await import('../dist/domains/ball-custody/ProposalStoreDelegateProvider.js');
const { RedisProposalStore } = await import('../dist/domains/cats/services/stores/redis/RedisProposalStore.js');

describe('F167 Redis proposal binding completeness', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  test('unrelated recent proposals cannot evict older approved Task bindings', async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F167 Redis proposal binding completeness');
    const redis = new Redis(REDIS_URL, { keyPrefix: `f167-binding-${randomUUID()}:` });
    try {
      const store = new RedisProposalStore(redis, { ttlSeconds: 0 });
      const createInput = (proposalId, overrides = {}) => ({
        proposalId,
        sourceThreadId: OWNER_THREAD,
        sourceInvocationId: 'inv-window',
        sourceCatId: OWNER_CAT,
        sourceMessageId: `msg-${proposalId}`,
        title: proposalId,
        reason: 'authorization window regression',
        parentThreadId: OWNER_THREAD,
        preferredCats: ['codex6-sol'],
        projectPath: '/test',
        createdBy: TENANT,
        subjectTaskId: TASK_ID,
        ...overrides,
      });
      const approve = async (proposalId, childThreadId) => {
        await store.create(createInput(proposalId));
        await store.claimForApproval({ proposalId, approvedBy: TENANT });
        await store.finalizeApproval({ proposalId, createdThreadId: childThreadId });
      };

      await approve('prop-old-approved', 'thread-old-approved');
      await approve('prop-new-approved', 'thread-new-approved');
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (let index = 0; index < 100; index += 1) {
        await store.create(createInput(`prop-unrelated-${index}`, { subjectTaskId: `task-unrelated-${index}` }));
      }

      assert.equal((await store.listByThread(OWNER_THREAD)).length, 100, 'default product listing remains bounded');
      const bindingProvider = new ThreadDelegateBindingProvider({
        listAllByThread: async (threadId) => store.listAllByThread(threadId),
      });
      const bindings = await bindingProvider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
      assert.deepEqual(
        bindings.map((binding) => binding.proposalId).sort(),
        ['prop-new-approved', 'prop-old-approved'],
        'authorization lookup must enumerate beyond the default product list window',
      );
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
});
