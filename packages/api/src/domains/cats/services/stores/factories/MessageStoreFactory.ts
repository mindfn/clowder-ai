/**
 * Message Store Factory
 * REDIS_URL 有值 → RedisMessageStore
 * 无 → MessageStore (内存，现有行为不变)
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { getRetentionTtlSeconds } from '../../../../../config/retention-ttl-provider.js';
import type { MessageAppendListener } from '../ports/MessageStore.js';
import { MessageStore } from '../ports/MessageStore.js';
import { RedisMessageStore } from '../redis/RedisMessageStore.js';

export type AnyMessageStore = MessageStore | RedisMessageStore;

export function createMessageStore(
  redis?: RedisClient,
  options?: { onAppend?: MessageAppendListener },
): AnyMessageStore {
  if (redis) {
    // F770: TTL comes from the in-memory retention provider — JSON-pushed value
    // or the legacy env fallback — re-evaluated per write, so a PUT applies
    // without a restart and the hot path does zero file IO.
    return new RedisMessageStore(redis, {
      ttlSeconds: () => getRetentionTtlSeconds('message'),
      onAppend: options?.onAppend,
    });
  }
  return new MessageStore({ onAppend: options?.onAppend });
}
