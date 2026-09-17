/**
 * Task Store Factory
 * REDIS_URL 有值 → RedisTaskStore
 * 无 → TaskStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { getRetentionTtlSeconds } from '../../../../../config/retention-ttl-provider.js';
import type { ITaskStore } from '../ports/TaskStore.js';
import { TaskStore } from '../ports/TaskStore.js';
import { RedisTaskStore } from '../redis/RedisTaskStore.js';

export function createTaskStore(redis?: RedisClient): ITaskStore {
  if (redis) {
    // F770: TTL comes from the in-memory retention provider — JSON-pushed value
    // or the legacy env fallback — re-evaluated per write, so a PUT applies
    // without a restart and the hot path does zero file IO.
    return new RedisTaskStore(redis, { ttlSeconds: () => getRetentionTtlSeconds('task') });
  }
  return new TaskStore();
}
