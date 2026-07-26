/**
 * InjectionTraceStore — F237 (Trace v0)
 *
 * Dual-layer Redis persistence for prompt injection traces:
 *   Layer 1: InjectionTraceSummary — persistent (TTL=0)
 *   Layer 2: InjectionTraceDetail — short TTL (default 7 days)
 */

import type { InjectionTraceDetail, InjectionTraceSummary, ReplaySnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SUMMARY_PREFIX = 'injection-trace-summary:';
const DETAIL_PREFIX = 'injection-trace-detail:';
const INDEX_PREFIX = 'injection-trace-index:';
const REPLAY_SNAPSHOT_PREFIX = 'replay-snapshot:';
/**
 * F257 Phase D: Registry of thread IDs with trace data.
 * Uses a Redis SET (SADD/SMEMBERS) instead of SCAN because ioredis keyPrefix
 * does NOT apply to SCAN MATCH patterns — SADD/SMEMBERS respect keyPrefix.
 * Populated on every persist() call; read by listTracedThreadIds().
 */
const THREAD_REGISTRY_KEY = 'injection-trace-thread-registry';
/**
 * Durable marker: set to '1' after the one-time backfill SCAN succeeds.
 * Decoupled from registry contents — new persist() SADDs don't prevent
 * legacy threads from being discovered (terra review P1, 2026-07-14).
 */
const BACKFILL_DONE_KEY = 'injection-trace-backfill-done';

function summaryKey(threadId: string, turnId: string): string {
  return `${SUMMARY_PREFIX}${threadId}:${turnId}`;
}
function detailKey(threadId: string, turnId: string): string {
  return `${DETAIL_PREFIX}${threadId}:${turnId}`;
}
function indexKey(threadId: string): string {
  return `${INDEX_PREFIX}${threadId}`;
}
function replaySnapshotKey(threadId: string, turnId: string, segmentId: string): string {
  return `${REPLAY_SNAPSHOT_PREFIX}${threadId}:${turnId}:${segmentId}`;
}
function replaySnapshotIndexKey(threadId: string, turnId: string): string {
  return `${REPLAY_SNAPSHOT_PREFIX}${threadId}:${turnId}:index`;
}

const DEFAULT_DETAIL_TTL_SECONDS = 7 * 24 * 60 * 60;

export class InjectionTraceStore {
  private readonly detailTtl: number;
  private backfillPromise: Promise<void> | null = null;

  constructor(
    private readonly redis: RedisClient,
    options?: { detailTtlSeconds?: number },
  ) {
    this.detailTtl = options?.detailTtlSeconds ?? DEFAULT_DETAIL_TTL_SECONDS;
  }

  async persist(summary: InjectionTraceSummary, detail: InjectionTraceDetail): Promise<void> {
    const sKey = summaryKey(summary.threadId, summary.turnId);
    const dKey = detailKey(detail.threadId, detail.turnId);
    const iKey = indexKey(summary.threadId);
    await this.redis.set(sKey, JSON.stringify(summary));
    await this.redis.set(dKey, JSON.stringify(detail), 'EX', this.detailTtl);
    await this.redis.zadd(iKey, summary.timestamp, summary.turnId);
    // F257 Phase D: register thread in discovery SET (SADD respects keyPrefix; SCAN does not).
    await this.redis.sadd(THREAD_REGISTRY_KEY, summary.threadId);
  }

  async getSummary(threadId: string, turnId: string): Promise<InjectionTraceSummary | null> {
    const raw = await this.redis.get(summaryKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceSummary;
    } catch {
      return null;
    }
  }

  async getDetail(threadId: string, turnId: string): Promise<InjectionTraceDetail | null> {
    const raw = await this.redis.get(detailKey(threadId, turnId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InjectionTraceDetail;
    } catch {
      return null;
    }
  }

  async listTurnIds(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ turnIds: string[]; total: number }> {
    const iKey = indexKey(threadId);
    const total = await this.redis.zcard(iKey);
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const turnIds = await this.redis.zrevrange(iKey, offset, offset + limit - 1);
    return { turnIds, total };
  }

  async listSummaries(
    threadId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ summaries: InjectionTraceSummary[]; total: number }> {
    const { turnIds, total } = await this.listTurnIds(threadId, options);
    const summaries: InjectionTraceSummary[] = [];
    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }
    return { summaries, total };
  }

  /**
   * F257: Time-windowed query for judgment engine consumption.
   *
   * Returns summaries within [startMs, endMs) for a given thread.
   * End-exclusive to match GuardRejectionEventLog.queryWindow boundary contract
   * and prevent double-counting in adjacent eval windows.
   *
   * The judgment engine uses this to compute per-segment injectionCount:
   *   queryWindow(threadId, windowStart, windowEnd) → filter segments by segmentId → count fired.
   */
  async queryWindow(threadId: string, startMs: number, endMs: number): Promise<InjectionTraceSummary[]> {
    const iKey = indexKey(threadId);
    // End-exclusive: ZRANGEBYSCORE is inclusive, so subtract 1ms to implement [start, end).
    // Matches GuardRejectionEventLog.queryWindow (line 177: `const upperBound = until - 1`).
    const turnIds = await this.redis.zrangebyscore(iKey, startMs, endMs - 1);
    const summaries: InjectionTraceSummary[] = [];
    for (const turnId of turnIds) {
      const summary = await this.getSummary(threadId, turnId);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * F257 Phase D: One-time backfill of the thread registry SET from pre-existing
   * index keys. Handles the cold-start gap: traces persisted before the registry
   * SET was added have index sorted sets but no SADD entry.
   *
   * Uses prefix-aware SCAN (ioredis keyPrefix does NOT apply to SCAN MATCH,
   * so we manually prepend the prefix). Controlled by a durable marker key
   * (BACKFILL_DONE_KEY) — NOT by registry emptiness, because new persist()
   * calls SADD new threads before backfill runs, making "registry non-empty"
   * an unreliable signal (terra P1, 2026-07-14).
   *
   * Called lazily on first listTracedThreadIds() — runs once per process lifetime.
   * Marker is set only after success; failure allows retry.
   */
  private async backfillRegistry(): Promise<void> {
    const done = await this.redis.get(BACKFILL_DONE_KEY);
    if (done) return;

    const prefix = this.redis.options?.keyPrefix ?? '';
    const pattern = `${prefix}${INDEX_PREFIX}*`;
    const prefixLen = prefix.length + INDEX_PREFIX.length;
    const discovered = new Set<string>();

    let cursor = '0';
    do {
      // Type assertion: ioredis scan overloads cause circular inference in do-while
      const result = (await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)) as [string, string[]];
      cursor = result[0];
      for (const key of result[1]) {
        const threadId = key.slice(prefixLen);
        if (threadId) discovered.add(threadId);
      }
    } while (cursor !== '0');

    if (discovered.size > 0) {
      await this.redis.sadd(THREAD_REGISTRY_KEY, ...discovered);
    }
    // Mark backfill as complete — only after successful SCAN.
    // No TTL: marker persists forever (backfill is a one-time migration).
    await this.redis.set(BACKFILL_DONE_KEY, '1');
  }

  /**
   * F257 Phase D: Discover all thread IDs that have injection trace data.
   * Used by the segment lifeline endpoint to scan across all threads.
   *
   * Primary: Redis SET (SMEMBERS) populated by persist() SADD calls.
   * Fallback: one-time backfill via prefix-aware SCAN for pre-existing data.
   * SADD/SMEMBERS respect ioredis keyPrefix; SCAN MATCH does not.
   */
  async listTracedThreadIds(): Promise<string[]> {
    if (!this.backfillPromise) {
      this.backfillPromise = this.backfillRegistry().catch(() => {
        this.backfillPromise = null; // Allow retry on transient failure
      });
    }
    await this.backfillPromise;
    return this.redis.smembers(THREAD_REGISTRY_KEY);
  }

  async deleteTurn(threadId: string, turnId: string): Promise<void> {
    await this.redis.del(summaryKey(threadId, turnId));
    await this.redis.del(detailKey(threadId, turnId));
    await this.redis.zrem(indexKey(threadId), turnId);
    // F257 Console 判据④：delete durable replay snapshots for this turn.
    const idxKey = replaySnapshotIndexKey(threadId, turnId);
    const snapshotKeys = await this.redis.smembers(idxKey);
    if (snapshotKeys.length > 0) {
      await this.redis.del(...snapshotKeys);
    }
    await this.redis.del(idxKey);
  }

  /**
   * F257 Console 判据④：persist durable, owner-scoped replay snapshots for a turn.
   *
   * TTL=0 by default — user-visible recoverable data. Separated from the
   * compact summary so that summary stays small while replay retains full
   * event-time content + context anchors. Maintains a per-turn index so
   * deleteTurn() can clean up all snapshots atomically.
   */
  async persistReplaySnapshots(threadId: string, turnId: string, snapshots: ReplaySnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    const idxKey = replaySnapshotIndexKey(threadId, turnId);
    const keys: string[] = [];
    for (const snapshot of snapshots) {
      const key = replaySnapshotKey(threadId, turnId, snapshot.segmentId);
      await this.redis.set(key, JSON.stringify(snapshot));
      keys.push(key);
    }
    await this.redis.sadd(idxKey, ...keys);
  }

  async getReplaySnapshot(threadId: string, turnId: string, segmentId: string): Promise<ReplaySnapshot | null> {
    const raw = await this.redis.get(replaySnapshotKey(threadId, turnId, segmentId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReplaySnapshot;
    } catch {
      return null;
    }
  }
}
