import { createHash } from 'node:crypto';
import type { LifecycleQueueEntry } from '@cat-cafe/shared';

const PRIORITY_RANK: Readonly<Record<LifecycleQueueEntry['priority'], number>> = { urgent: 0, normal: 1 };

export interface LifecycleQueueOrderKey {
  readonly id: string;
  readonly priority: LifecycleQueueEntry['priority'];
  readonly enqueuedAt: number;
  readonly position?: number;
}

/** The only lifecycle Queue comparator: position → priority → FIFO → stable id. */
export function compareLifecycleQueueEntries(a: LifecycleQueueOrderKey, b: LifecycleQueueOrderKey): number {
  const aPositioned = a.position !== undefined;
  const bPositioned = b.position !== undefined;
  if (aPositioned !== bPositioned) return aPositioned ? -1 : 1;
  if (a.position !== undefined && b.position !== undefined && a.position !== b.position) {
    return a.position - b.position;
  }
  const priorityDelta = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface QueueOrderShadowComparison {
  readonly matches: boolean;
  readonly legacyEntryIds: readonly string[];
  readonly lifecycleEntryIds: readonly string[];
  readonly firstMismatchIndex?: number;
}

/** Read-only delta used while the new comparator is dark-landed behind the legacy writer. */
export function compareQueueOrderShadow(
  legacyEntryIds: readonly string[],
  lifecycleEntries: readonly LifecycleQueueOrderKey[],
): QueueOrderShadowComparison {
  const legacy = [...legacyEntryIds];
  const lifecycle = [...lifecycleEntries].sort(compareLifecycleQueueEntries).map((entry) => entry.id);
  const limit = Math.max(legacy.length, lifecycle.length);
  for (let index = 0; index < limit; index += 1) {
    if (legacy[index] !== lifecycle[index]) {
      return {
        matches: false,
        legacyEntryIds: legacy,
        lifecycleEntryIds: lifecycle,
        firstMismatchIndex: index,
      };
    }
  }
  return { matches: true, legacyEntryIds: legacy, lifecycleEntryIds: lifecycle };
}

/** Remember a diagnostic scope once while bounding process-lifetime retention. */
export function rememberBoundedShadowScope(scopes: Set<string>, scope: string, maxScopes: number): boolean {
  if (!Number.isInteger(maxScopes) || maxScopes < 1) throw new RangeError('maxScopes must be a positive integer');
  if (scopes.has(scope)) return false;
  while (scopes.size >= maxScopes) {
    const oldestScope = scopes.values().next().value;
    if (oldestScope === undefined) break;
    scopes.delete(oldestScope);
  }
  scopes.add(scope);
  return true;
}

export interface QueueOrderShadowSummary {
  readonly legacyCount: number;
  readonly lifecycleCount: number;
  readonly legacyEntryIdSample: readonly string[];
  readonly lifecycleEntryIdSample: readonly string[];
  readonly legacyOrderDigest: string;
  readonly lifecycleOrderDigest: string;
  readonly firstMismatchIndex?: number;
}

function orderDigest(entryIds: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(entryIds)).digest('hex').slice(0, 16);
}

/** Produce a content-free, fixed-size log payload from a full in-memory comparison. */
export function summarizeQueueOrderShadow(
  comparison: QueueOrderShadowComparison,
  sampleLimit: number,
): QueueOrderShadowSummary {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    throw new RangeError('sampleLimit must be a non-negative integer');
  }
  return {
    legacyCount: comparison.legacyEntryIds.length,
    lifecycleCount: comparison.lifecycleEntryIds.length,
    legacyEntryIdSample: comparison.legacyEntryIds.slice(0, sampleLimit),
    lifecycleEntryIdSample: comparison.lifecycleEntryIds.slice(0, sampleLimit),
    legacyOrderDigest: orderDigest(comparison.legacyEntryIds),
    lifecycleOrderDigest: orderDigest(comparison.lifecycleEntryIds),
    firstMismatchIndex: comparison.firstMismatchIndex,
  };
}
