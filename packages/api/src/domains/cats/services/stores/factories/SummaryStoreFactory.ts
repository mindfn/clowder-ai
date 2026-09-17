/**
 * Summary Store Factory
 * REDIS_URL 有值 → RedisSummaryStore
 * 无 → SummaryStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { getRetentionTtlSeconds } from '../../../../../config/retention-ttl-provider.js';
import type { ISummaryStore } from '../ports/SummaryStore.js';
import { SummaryStore } from '../ports/SummaryStore.js';
import { RedisSummaryStore } from '../redis/RedisSummaryStore.js';

export function createSummaryStore(redis?: RedisClient): ISummaryStore {
  if (redis) {
    // F770: TTL comes from the in-memory retention provider — JSON-pushed value
    // or the legacy env fallback — re-evaluated per write, so a PUT applies
    // without a restart and the hot path does zero file IO.
    return new RedisSummaryStore(redis, { ttlSeconds: () => getRetentionTtlSeconds('summary') });
  }
  return new SummaryStore();
}
