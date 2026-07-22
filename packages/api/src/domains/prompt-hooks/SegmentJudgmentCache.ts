/**
 * SegmentJudgmentCache — F257 Phase D
 *
 * Lightweight Redis cache for the latest per-segment judgment results.
 *
 * The segment-judgment-engine produces verdicts during eval runs, but results
 * are transient (formatted into eval cat evidence text, never persisted).
 * This cache stores the latest judgment per segment so the lifeline API can
 * show eval stage data without re-running the judgment engine.
 *
 * Storage: Redis HASH — one field per segmentId, value = JSON(CachedJudgment).
 * Written after each eval run, read by GET /api/segment-lifeline/:segmentId.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { SegmentJudgment, SegmentVerdict } from '../../infrastructure/harness-eval/segment-judgment-engine.js';

const CACHE_KEY = 'segment-judgment-latest';
/** Per-segment ZSET storing all judgment history, scored by evaluatedAt. P1-2. */
const HISTORY_KEY = (segmentId: string) => `segment-judgment-history:${segmentId}`;

/**
 * Subset of SegmentJudgment stored in the cache — only what the lifeline needs.
 *
 * 判据② (F257 #6 slice 6c): `window` + `denominatorKind` are REQUIRED on every
 * producer write — the judgment engine always has them, so the write path
 * cannot omit them. `null` is reserved for ONE case: legacy Redis JSON written
 * before slice 6c, normalized on read (fail-visible provenance gap — never
 * guessed from `evaluatedAt`, never silently replaced by the query window).
 */
export interface CachedJudgment {
  segmentId: string;
  verdict: SegmentVerdict;
  injectionCount: number;
  violationCount: number;
  correlationConfidence: string;
  evaluatedAt: number;
  runId: string;
  /** Version of the segment when judgment was produced. Used for epoch attribution. */
  segmentVersion: number | null;
  /** The judgment's OWN eval sampling window [startMs, endMs). null = legacy entry (unknown). */
  window: { startMs: number; endMs: number } | null;
  /** Denominator semantics of the counts. null = legacy entry (unknown). */
  denominatorKind: 'fired-count' | 'session-count' | 'none' | null;
}

/** Closed union of denominator semantics — anything off-domain is malformed, not "unknown". */
const DENOMINATOR_KINDS = new Set(['fired-count', 'session-count', 'none']);

/**
 * 判据② P2-1 (sol R1): validate a PRESENT window field at the Redis read
 * boundary. Missing (legacy) → null; present-but-malformed → null as well,
 * because a forged window reaching the UI renders `Invalid Date ~ Invalid Date`
 * and fakes a coordinate — worse than an honest gap.
 */
function normalizeWindow(raw: unknown): { startMs: number; endMs: number } | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const w = raw as { startMs?: unknown; endMs?: unknown };
  if (typeof w.startMs !== 'number' || typeof w.endMs !== 'number') return null;
  if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) return null;
  if (w.startMs > w.endMs) return null; // illegal [startMs,endMs) order
  return { startMs: w.startMs, endMs: w.endMs };
}

/** denominatorKind: only the closed union survives; anything else → null (fail-visible). */
function normalizeDenominatorKind(raw: unknown): CachedJudgment['denominatorKind'] {
  return typeof raw === 'string' && DENOMINATOR_KINDS.has(raw) ? (raw as CachedJudgment['denominatorKind']) : null;
}

/**
 * Normalize a raw JSON parse into CachedJudgment (判据②): legacy entries
 * written before slice 6c lack window/denominatorKind — surface the gap as
 * explicit null instead of leaking `undefined` downstream.
 *
 * P2-1: present-but-malformed provenance fields also normalize to null
 * (fail-closed at the Redis read boundary), and non-record raw (e.g. a JSON
 * array) is rejected outright — never cast into a full CachedJudgment.
 */
function normalizeCachedJudgment(raw: unknown): CachedJudgment | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const j = raw as Partial<CachedJudgment>;
  return {
    ...(j as CachedJudgment),
    window: normalizeWindow(j.window),
    denominatorKind: normalizeDenominatorKind(j.denominatorKind),
  };
}

export class SegmentJudgmentCache {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Store latest judgments (batch write after eval run).
   * Each segment overwrites its previous entry — only latest matters.
   */
  async updateBatch(judgments: SegmentJudgment[]): Promise<void> {
    if (judgments.length === 0) return;

    const pipeline = this.redis.pipeline();
    for (const j of judgments) {
      const cached: CachedJudgment = {
        segmentId: j.segmentId,
        verdict: j.verdict,
        injectionCount: j.evidence.injectionCount.value,
        violationCount: j.evidence.violationCount.value,
        correlationConfidence: j.evidence.correlationConfidence,
        evaluatedAt: j.window.endMs,
        runId: j.producedBy.runId,
        segmentVersion: j.segmentVersion,
        // 判据②: the judgment's OWN eval window + denominator — always present
        // on the producer path (SegmentJudgment requires both).
        window: { startMs: j.window.startMs, endMs: j.window.endMs },
        denominatorKind: j.evidence.denominatorKind,
      };
      pipeline.hset(CACHE_KEY, j.segmentId, JSON.stringify(cached));
      // P1-2: append to per-segment history ZSET (scored by evaluatedAt, permanent)
      pipeline.zadd(HISTORY_KEY(j.segmentId), cached.evaluatedAt, JSON.stringify(cached));
    }
    await pipeline.exec();
  }

  /** Read cached judgment for a single segment. */
  async get(segmentId: string): Promise<CachedJudgment | null> {
    const raw = await this.redis.hget(CACHE_KEY, segmentId);
    if (!raw) return null;
    try {
      return normalizeCachedJudgment(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Read cached judgments for multiple segments (batch). */
  async getBatch(segmentIds: string[]): Promise<Map<string, CachedJudgment>> {
    if (segmentIds.length === 0) return new Map();

    const results = new Map<string, CachedJudgment>();
    const pipeline = this.redis.pipeline();
    for (const id of segmentIds) {
      pipeline.hget(CACHE_KEY, id);
    }
    const replies = await pipeline.exec();
    if (!replies) return results;

    for (let i = 0; i < segmentIds.length; i++) {
      const reply = replies[i];
      if (!reply || reply[0]) continue; // error or null
      const raw = reply[1] as string | null;
      if (!raw) continue;
      try {
        const normalized = normalizeCachedJudgment(JSON.parse(raw));
        if (normalized) results.set(segmentIds[i], normalized);
      } catch {
        // skip malformed entries
      }
    }
    return results;
  }

  /**
   * Read full judgment history for a segment (P1-2: per-version eval).
   * Returns all judgments ordered by evaluatedAt (oldest first).
   * Limit defaults to 100 — more than enough for any realistic lifetime.
   */
  async getHistory(segmentId: string, limit = 100): Promise<CachedJudgment[]> {
    const raws = await this.redis.zrangebyscore(HISTORY_KEY(segmentId), 0, '+inf', 'LIMIT', 0, limit);
    const results: CachedJudgment[] = [];
    for (const raw of raws) {
      try {
        const normalized = normalizeCachedJudgment(JSON.parse(raw));
        if (normalized) results.push(normalized);
      } catch {
        /* skip malformed */
      }
    }
    return results;
  }
}
