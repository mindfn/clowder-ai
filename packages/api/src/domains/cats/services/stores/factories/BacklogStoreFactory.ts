/**
 * Backlog Store Factory
 * REDIS_URL 有值 → RedisBacklogStore
 * 无 → BacklogStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { getRetentionTtlSeconds } from '../../../../../config/retention-ttl-provider.js';
import type { IBacklogStore } from '../ports/BacklogStore.js';
import { BacklogStore } from '../ports/BacklogStore.js';
import { RedisBacklogStore } from '../redis/RedisBacklogStore.js';

export function createBacklogStore(redis?: RedisClient): IBacklogStore {
  if (redis) {
    // F770: TTL comes from the in-memory retention provider — JSON-pushed value
    // or the legacy env fallback — re-evaluated per write, so a PUT applies
    // without a restart and the hot path does zero file IO.
    return new RedisBacklogStore(redis, { ttlSeconds: () => getRetentionTtlSeconds('backlog') });
  }
  return new BacklogStore();
}
