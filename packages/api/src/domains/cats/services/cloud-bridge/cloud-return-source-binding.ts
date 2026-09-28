import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

/**
 * F202 W2-3 h3c-2 (review P1-3) — one source, one cloud cat, for good. A polled return carries no
 * dispatch identity of its own: the Host attributes it to the cat its grant names. So the first grant
 * for a source binds the source to that cat, and the binding outlives every grant: it never expires,
 * is never refreshed and is never overwritten. Grants can lapse and be issued again; the owner cannot
 * change. A grant for another cat is refused, and a grant is only claimable while its source belongs
 * to its cat — an answer that arrives days late from the native inbox still cannot be recorded as the
 * wrong cat. The cost is one small key per message ever sent to a cloud cat.
 */

const SOURCE_PREFIX = 'cloud-bridge:return-source:';
/** The owner of a source two persisted grants disagreed about: it belongs to no cat. */
export const UNOWNED_SOURCE = '!unowned';

export interface CloudReturnSource {
  readonly threadId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly targetCatId: string;
}

export function cloudReturnSourceKey(source: Omit<CloudReturnSource, 'targetCatId'>): string {
  const material = JSON.stringify({
    v: 1,
    threadId: source.threadId,
    userId: source.userId,
    sourceMessageId: source.sourceMessageId,
  });
  return `${SOURCE_PREFIX}${createHash('sha256').update(material).digest('hex')}`;
}

/** `bound` when the source belongs to this cat; otherwise its owner — `null` when none can be named. */
export type SourceBinding = { readonly bound: true } | { readonly bound: false; readonly owner: string | null };

function refusal(owner: string | null): SourceBinding {
  return { bound: false, owner: owner === UNOWNED_SOURCE ? null : owner };
}

/** Binds a free source to this cat, or reports whose it already is. Write-once: never overwrites. */
export async function bindSourceInRedis(
  redis: Pick<RedisClient, 'set' | 'get'>,
  source: CloudReturnSource,
): Promise<SourceBinding> {
  const key = cloudReturnSourceKey(source);
  if ((await redis.set(key, source.targetCatId, 'NX')) === 'OK') return { bound: true };
  const owner = await redis.get(key);
  // A binding is never removed; if it is gone anyway, nobody can be proven to own the source.
  return owner === source.targetCatId ? { bound: true } : refusal(owner);
}

export async function sourceOwnerInRedis(
  redis: Pick<RedisClient, 'get'>,
  source: Omit<CloudReturnSource, 'targetCatId'>,
): Promise<string | null> {
  return redis.get(cloudReturnSourceKey(source));
}

/** A source two persisted grants disagree about can be proven to belong to neither. */
export async function markSourceUnownedInRedis(
  redis: Pick<RedisClient, 'set'>,
  source: Omit<CloudReturnSource, 'targetCatId'>,
): Promise<void> {
  await redis.set(cloudReturnSourceKey(source), UNOWNED_SOURCE);
}

export class MemorySourceBindings {
  private readonly owners = new Map<string, string>();

  bind(source: CloudReturnSource): SourceBinding {
    const key = cloudReturnSourceKey(source);
    const owner = this.owners.get(key);
    if (owner === undefined) {
      this.owners.set(key, source.targetCatId);
      return { bound: true };
    }
    return owner === source.targetCatId ? { bound: true } : refusal(owner);
  }

  ownerOf(source: Omit<CloudReturnSource, 'targetCatId'>): string | null {
    return this.owners.get(cloudReturnSourceKey(source)) ?? null;
  }
}

const MIGRATED_KEY = `${SOURCE_PREFIX}migrated`;

/**
 * Grants persisted before sources were bound are dispatches all the same: before admitting anything,
 * bind each such grant's source to its cat. A source two of them disagree about belongs to neither.
 * Runs once per Redis database; a marker records that it did.
 */
export async function bindPersistedSourcesInRedis(
  redis: Pick<RedisClient, 'get' | 'set' | 'scan'>,
  grants: { readonly keyPattern: string; readonly read: (raw: string | null) => CloudReturnSource | null },
): Promise<void> {
  if ((await redis.get(MIGRATED_KEY)) === 'v1') return;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', grants.keyPattern, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      const source = grants.read(await redis.get(key));
      if (!source) continue;
      const binding = await bindSourceInRedis(redis, source);
      if (!binding.bound && binding.owner !== null) await markSourceUnownedInRedis(redis, source);
    }
  } while (cursor !== '0');
  await redis.set(MIGRATED_KEY, 'v1');
}
