/**
 * Thread Store Factory
 * REDIS_URL 有值 → RedisThreadStore
 * 无 → ThreadStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { getRetentionTtlSeconds } from '../../../../../config/retention-ttl-provider.js';
import type { IThreadStore } from '../ports/ThreadStore.js';
import { ThreadStore } from '../ports/ThreadStore.js';
import { RedisThreadStore } from '../redis/RedisThreadStore.js';

export function createThreadStore(redis?: RedisClient): IThreadStore {
  if (redis) {
    // F770: TTL comes from the in-memory retention provider — JSON-pushed value
    // or the legacy env fallback — re-evaluated per write, so a PUT applies
    // without a restart and the hot path does zero file IO.
    return new RedisThreadStore(redis, { ttlSeconds: () => getRetentionTtlSeconds('thread') });
  }
  return new ThreadStore();
}
