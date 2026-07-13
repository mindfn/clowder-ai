/**
 * F257 GuardRejectionEventLog — Phase A Line B
 *
 * Append-only event log for structured guard rejection events.
 * Communication channel between emit points (HTTP routes + route-serial)
 * and the harness evaluation layer (eval:harness-ledger domain).
 *
 * Uses Redis ZSET with timestamp scores for time-windowed discovery
 * (unlike F254 FreshnessAttentionEventLog which uses LIST per-invocation).
 * ZSET enables `queryWindow({since, until})` without knowing which keys
 * to scan — critical for weekly eval batch processing.
 *
 * **Fail-open**: observation layer failures NEVER block business calls.
 * All Redis operations are wrapped in try/catch with silent fallback.
 *
 * Closed union type with `kind` discriminator (F257 spec §2.1b).
 * Week 1 implements 2 of 6 event kinds:
 *   http_rate_limit | route_decision_block
 *
 * Storage layout:
 *   ZSET  guard-rejection:events        — { eventJSON → timestamp }
 *   (single ZSET; partition per-guardId later if volume demands)
 *
 * Retention: 7 days (pruned on each append via ZREMRANGEBYSCORE).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';

// ---------------------------------------------------------------------------
// Event type definitions (closed union)
// ---------------------------------------------------------------------------

interface GuardRejectionEventBase {
  /** Unique event ID for ZSET member uniqueness. */
  eventId: string;
  /** Discriminator for closed union. */
  kind: string;
  /** Thread where the rejection occurred. */
  threadId: string;
  /** Cat that triggered the rejection. */
  catId: string;
  /** Identifier for the guard that rejected (e.g., 'hold_ball_rate_limit'). */
  guardId: string;
  /** Unix epoch ms. Also used as ZSET score. */
  timestamp: number;
  /** Week 1 = 'window' (threadId+catId+timestamp window correlation). */
  correlationConfidence: 'window' | 'exact';
}

/** hold_ball 429 — maxHoldsPerWindow exceeded (HTTP route layer). */
export interface HttpRateLimitEvent extends GuardRejectionEventBase {
  kind: 'http_rate_limit';
  /** Current hold count at rejection time. */
  currentCount: number;
  /** Configured maximum holds per window. */
  maxAllowed: number;
  /** Window duration in ms. */
  windowMs: number;
}

/** A2A block_pingpong — streak termination (generator layer). */
export interface RouteDecisionBlockEvent extends GuardRejectionEventBase {
  kind: 'route_decision_block';
  /** Cat that initiated the blocked A2A mention. */
  fromCatId: string;
  /** Cat that was the blocked A2A target. */
  targetCatId: string;
  /** Ping-pong streak count that triggered the block. */
  streakCount: number;
}

// Future Week 2+ event kinds (F257 spec §2.1b):
// http_schema_reject | http_policy_reject | publish_policy_reject | route_decision_skip

export type GuardRejectionEvent = HttpRateLimitEvent | RouteDecisionBlockEvent;

export type GuardRejectionKind = GuardRejectionEvent['kind'];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis key for the global guard rejection ZSET. */
const EVENTS_ZSET = 'guard-rejection:events';

/** TTL: 7 days in milliseconds — events older than this are pruned on append. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default query limit to prevent unbounded reads. */
const DEFAULT_QUERY_LIMIT = 200;

// ---------------------------------------------------------------------------
// Event Log
// ---------------------------------------------------------------------------

export class GuardRejectionEventLog {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Append a guard rejection event to the global ZSET.
   *
   * **Fail-open**: silently swallows all errors. Observation layer
   * must never block or degrade the business call that triggered it.
   *
   * Also prunes events older than RETENTION_MS (idempotent, cheap —
   * ZREMRANGEBYSCORE is O(log(N)+M) where M = removed count).
   */
  async append(event: GuardRejectionEvent): Promise<void> {
    try {
      const serialized = JSON.stringify(event);
      await this.redis.zadd(EVENTS_ZSET, event.timestamp, serialized);
      // Prune stale events (fail-open: errors here don't matter)
      const cutoff = event.timestamp - RETENTION_MS;
      await this.redis.zremrangebyscore(EVENTS_ZSET, 0, cutoff);
    } catch {
      // Fail-open: observation layer never blocks business
    }
  }

  /**
   * Query events within a time window, optionally filtered by guardId/threadId/catId.
   *
   * **Fail-open**: returns empty array on any error.
   *
   * Fetches ALL events in the time window from Redis, then filters in-app.
   * LIMIT is applied AFTER filtering to prevent non-matching events from
   * consuming result slots (P2 fix: codex review 629795f29).
   *
   * @param opts.since - Window start (inclusive), Unix epoch ms.
   * @param opts.until - Window end (exclusive), Unix epoch ms. Defaults to now.
   * @param opts.guardId - Filter by guard identifier.
   * @param opts.threadId - Filter by thread.
   * @param opts.catId - Filter by cat.
   * @param opts.limit - Max results after filtering (default 200).
   */
  async queryWindow(opts: {
    since: number;
    until?: number;
    guardId?: string;
    threadId?: string;
    catId?: string;
    limit?: number;
  }): Promise<GuardRejectionEvent[]> {
    try {
      const until = opts.until ?? Date.now();
      const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
      // Exclusive upper bound: subtract 1ms from until (ZRANGEBYSCORE is inclusive).
      // This aligns with PromptSegmentsSourceSelector [windowStartMs, windowEndMs).
      const upperBound = until - 1;
      const raw = await this.redis.zrangebyscore(EVENTS_ZSET, opts.since, upperBound);
      let events: GuardRejectionEvent[] = [];
      for (const s of raw) {
        try {
          events.push(JSON.parse(s) as GuardRejectionEvent);
        } catch {
          /* skip corrupted entries */
        }
      }
      // Filter in-app BEFORE applying limit
      if (opts.guardId) events = events.filter((e) => e.guardId === opts.guardId);
      if (opts.threadId) events = events.filter((e) => e.threadId === opts.threadId);
      if (opts.catId) events = events.filter((e) => e.catId === opts.catId);
      return events.slice(0, limit);
    } catch {
      return []; // Fail-open
    }
  }

  /**
   * Strict (fail-closed) query for the eval read path.
   *
   * Same logic as queryWindow but does NOT swallow Redis errors.
   * Eval generators MUST use this — a Redis outage must produce a 500
   * (generator throws), NOT a false "zero events" verdict.
   *
   * Business-facing callers keep using queryWindow (fail-open).
   *
   * P1 fix (codex review 04a8c368b): Redis fail-open queryWindow returned []
   * on error, which the generator misinterpreted as genuine zero events and
   * wrote a false noFindingRecord verdict polluting the eval chain.
   */
  async queryWindowStrict(opts: {
    since: number;
    until?: number;
    guardId?: string;
    threadId?: string;
    catId?: string;
    limit?: number;
  }): Promise<GuardRejectionEvent[]> {
    const until = opts.until ?? Date.now();
    const limit = opts.limit ?? DEFAULT_QUERY_LIMIT;
    const upperBound = until - 1;
    const raw = await this.redis.zrangebyscore(EVENTS_ZSET, opts.since, upperBound);
    let events: GuardRejectionEvent[] = [];
    for (const s of raw) {
      try {
        events.push(JSON.parse(s) as GuardRejectionEvent);
      } catch {
        /* skip corrupted entries — parse errors are data-quality, not infra */
      }
    }
    if (opts.guardId) events = events.filter((e) => e.guardId === opts.guardId);
    if (opts.threadId) events = events.filter((e) => e.threadId === opts.threadId);
    if (opts.catId) events = events.filter((e) => e.catId === opts.catId);
    return events.slice(0, limit);
  }

  /**
   * Count events matching a guardId within a time window.
   * Useful for threshold-driven attribution triggers (default 3/7d).
   *
   * **Fail-open**: returns 0 on any error.
   */
  async countByGuard(guardId: string, since: number, until?: number): Promise<number> {
    const events = await this.queryWindow({ since, until, guardId });
    return events.length;
  }
}
