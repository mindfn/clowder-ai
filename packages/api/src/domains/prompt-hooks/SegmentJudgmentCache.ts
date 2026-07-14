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

/** Subset of SegmentJudgment stored in the cache — only what the lifeline needs. */
export interface CachedJudgment {
  segmentId: string;
  verdict: SegmentVerdict;
  injectionCount: number;
  violationCount: number;
  correlationConfidence: string;
  evaluatedAt: number;
  runId: string;
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
      };
      pipeline.hset(CACHE_KEY, j.segmentId, JSON.stringify(cached));
    }
    await pipeline.exec();
  }

  /** Read cached judgment for a single segment. */
  async get(segmentId: string): Promise<CachedJudgment | null> {
    const raw = await this.redis.hget(CACHE_KEY, segmentId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedJudgment;
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
        results.set(segmentIds[i], JSON.parse(raw) as CachedJudgment);
      } catch {
        // skip malformed entries
      }
    }
    return results;
  }
}
