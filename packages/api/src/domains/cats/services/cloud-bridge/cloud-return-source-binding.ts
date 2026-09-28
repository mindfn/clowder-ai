import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

/**
 * F202 W2-3 h3c-2 (review P1-3) — one source, one cloud cat. A polled return carries no dispatch
 * identity of its own: the Host attributes it to the cat its grant names. If one source could hold
 * grants for two cats — sent to one, then after a rename to the next — a late answer from the first
 * could claim the second's grant and be recorded as the wrong cat. So the first grant binds its source
 * to that cat for as long as grants are kept; a grant for another cat is then refused, and the message
 * has to be sent anew.
 */

const SOURCE_PREFIX = 'cloud-bridge:return-source:';

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

/** `bound` when the source now belongs to this cat; otherwise the cat it already belongs to. */
export type SourceBinding = { readonly bound: true } | { readonly bound: false; readonly boundTargetCatId?: string };

export async function bindSourceInRedis(
  redis: Pick<RedisClient, 'set' | 'get'>,
  source: CloudReturnSource,
  retentionMs: number,
): Promise<SourceBinding> {
  const key = cloudReturnSourceKey(source);
  // Two tries: the binding can expire between a refused SET NX and the GET that reads it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await redis.set(key, source.targetCatId, 'PX', retentionMs, 'NX')) === 'OK') return { bound: true };
    const boundTo = await redis.get(key);
    if (boundTo === source.targetCatId) {
      await redis.set(key, boundTo, 'PX', retentionMs, 'XX');
      return { bound: true };
    }
    if (boundTo !== null) return { bound: false, boundTargetCatId: boundTo };
  }
  return { bound: false };
}

/** Keeps a consumed grant's source bound for as long as the consumed grant itself is kept. */
export async function refreshSourceInRedis(
  redis: Pick<RedisClient, 'set'>,
  source: CloudReturnSource,
  retentionMs: number,
): Promise<void> {
  await redis.set(cloudReturnSourceKey(source), source.targetCatId, 'PX', retentionMs, 'XX');
}

export class MemorySourceBindings {
  private readonly bindings = new Map<string, { readonly targetCatId: string; readonly expiresAt: number }>();

  constructor(
    private readonly now: () => number,
    private readonly retentionMs: number,
  ) {}

  bind(source: CloudReturnSource): SourceBinding {
    const key = cloudReturnSourceKey(source);
    const existing = this.bindings.get(key);
    if (existing && existing.expiresAt > this.now() && existing.targetCatId !== source.targetCatId) {
      return { bound: false, boundTargetCatId: existing.targetCatId };
    }
    this.bindings.set(key, { targetCatId: source.targetCatId, expiresAt: this.now() + this.retentionMs });
    return { bound: true };
  }

  refresh(source: CloudReturnSource): void {
    const key = cloudReturnSourceKey(source);
    const existing = this.bindings.get(key);
    if (existing?.targetCatId === source.targetCatId) {
      this.bindings.set(key, { targetCatId: existing.targetCatId, expiresAt: this.now() + this.retentionMs });
    }
  }
}
