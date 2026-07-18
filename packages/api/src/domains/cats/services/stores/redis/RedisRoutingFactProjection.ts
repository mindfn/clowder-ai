/**
 * F257 V1 — RoutingDecisionFact query projection (§4.5.1 of the F257 redesign).
 *
 * Authority = the `routingFact` field embedded in the message hash (same-append
 * co-fate; RedisMessageStore). This module derives the owner-scoped query
 * projection and implements the §4.5.1 collection-integrity contract:
 *   ① persisted owner-scoped high-watermark (highest projected authority id)
 *   ② reconcile-before-evaluate: authority vs projection window对账 with
 *      synchronous idempotent rebuild; rebuild failure → metrics unmeasurable
 *   ③ projection worker errors are never silently swallowed — they are logged
 *      AND persisted to an error ZSET (collection-health visibility)
 *
 * Metric semantics (@解析成功率 per parserMode): T-A (§3.4) via the mapping
 * functions in routing-attempt.ts — not restated here.
 *
 * Redis-only by design: the in-memory MessageStore has no projection; metric
 * endpoints report unmeasurable without Redis.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  isMetricEligibleOutcome,
  isSuccessOutcome,
  type RoutingParserMode,
} from '../../agents/routing/routing-attempt.js';
import type { StoredMessage } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { RoutingFactKeys } from '../redis-keys/routing-fact-keys.js';
import {
  type PersistedMessageInvalidReason,
  parsePersistedMessageRecord,
  safeParseRoutingFact,
} from './redis-message-parsers.js';

const log = createModuleLogger('routing-fact-projection');

/** Advance the watermark only forward (sortable ids are fixed-width → lexicographic order = time order). */
const WATERMARK_ADVANCE_LUA = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or (ARGV[1] > cur) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

export interface RoutingFactReconcileResult {
  ok: boolean;
  /**
   * set when !ok — distinguishes infrastructure failure from collection gap
   * (sol R1 P1-1); 'malformed_provenance' (sol R4 P1-1c) = a window message
   * carries a corrupt declaration, so cohort membership is unknowable and the
   * window must read as unmeasurable instead of silently excluding it.
   */
  reason?:
    | 'redis_error'
    | 'producer_gap'
    | 'malformed_provenance'
    | 'malformed_authority_fact'
    | 'malformed_record'
    | 'collection_gap';
  /** canonical validator rejected this many routingFact payloads */
  malformedFactCount?: number;
  /** window messages that must carry a fact (routable-message cohort, producer-run audit) */
  cohortCount: number;
  /** cohort messages that DO carry a fact (zero-token batches included) */
  authorityCount: number;
  /** cohort messages missing the fact field — every one is a producer that did not run */
  producerGapCount: number;
  projectedCount: number;
  repairedMissing: number;
  removedStale: number;
}

interface ModeAggregate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0 (no eligible attempts in window) */
  rate: number | null;
  batches: number;
}

export type ResolutionRateResult =
  | {
      unmeasurable: true;
      reason: 'reconcile_failed' | 'producer_gap' | 'read_failed' | 'malformed_authority_fact';
      /** present for reconcile-derived unmeasurables — shows WHICH gap (sol R1 P1-1) */
      coverage?: RoutingFactReconcileResult;
      /** present for reason='malformed_authority_fact' (sol R1 P1-3) */
      malformedFacts?: number;
    }
  | {
      unmeasurable: false;
      window: { fromTs: number; toTs: number };
      coverage: RoutingFactReconcileResult;
      modes: Record<RoutingParserMode, ModeAggregate>;
      /** batches excluded by batch-level metricEligible=false (T-A 右截断) */
      excludedBatches: number;
      /** authority records whose fact field failed to parse — reported, never silently dropped */
      malformedFacts: number;
    };

type ProjectableMessage = Pick<StoredMessage, 'id' | 'userId' | 'timestamp' | 'routingFact'>;

/**
 * ioredis multi()/pipeline() exec() resolves per-command errors inside the
 * result tuples instead of rejecting. Every projection write path must check
 * them explicitly (sol R1 P1-5) — a null result array (aborted transaction)
 * counts as failure too.
 */
function assertExecResultsOk(results: Array<[error: Error | null, result: unknown]> | null, context: string): void {
  if (!results) {
    throw new Error(`${context}: pipeline exec aborted (null result)`);
  }
  for (const [err] of results) {
    if (err) throw err;
  }
}

export class RedisRoutingFactProjection {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Derive projection entries for one fact-carrying message (async worker path).
   * Never throws — failures are logged and persisted to the error ZSET (§4.5.1③);
   * reconcileWindow() repairs the gap before any evaluation reads the window.
   */
  async project(msg: ProjectableMessage): Promise<void> {
    const fact = msg.routingFact;
    // sol R1 P1-1: zero-token batches ARE authority records (producer-run marker)
    // — indexing them keeps the coverage cohort complete-by-construction.
    if (!fact) return;
    try {
      const pipeline = this.redis.multi();
      pipeline.zadd(RoutingFactKeys.index(msg.userId), String(msg.timestamp), msg.id);
      // sol R1 P1-5: MULTI resolves per-command errors in the result tuples
      // without throwing — swallowing them would advance the watermark over a
      // failed write and getHealth would report a clean collection.
      assertExecResultsOk(await pipeline.exec(), 'project');
      await this.redis.eval(WATERMARK_ADVANCE_LUA, 1, RoutingFactKeys.watermark(msg.userId), msg.id);
    } catch (error) {
      log.error({ error, messageId: msg.id, ownerUserId: msg.userId }, 'routing-fact projection write failed');
      try {
        await this.redis.zadd(RoutingFactKeys.projectionErrors(msg.userId), String(Date.now()), msg.id);
      } catch (markError) {
        log.error({ markError, messageId: msg.id }, 'routing-fact projection error marker write failed');
      }
    }
  }

  /**
   * Read the `routingFact` field for a list of message ids in one pipeline.
   * Returns null on ANY read error — partial reads would silently bias counts.
   */
  private async readFactPayloads(ids: readonly string[]): Promise<Array<string | null> | null> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hget(MessageKeys.detail(id), 'routingFact');
    }
    const results = await pipeline.exec();
    if (!results || results.length !== ids.length) return null;
    const payloads: Array<string | null> = [];
    for (const entry of results) {
      const [err, value] = entry as [Error | null, unknown];
      if (err) return null;
      payloads.push(typeof value === 'string' && value.length > 0 ? value : null);
    }
    return payloads;
  }

  /**
   * Read cohort-audit fields for a list of message ids in one pipeline
   * (sol R3 P1-1). Returns null on ANY read error. Three-state provenance
   * (sol R4 P1-1c): 'absent' = legacy pre-contract message (honestly out of
   * cohort); 'malformed' = declaration present but corrupt — surfaced to the
   * caller so the whole window reads unmeasurable, never silently excluded.
   */
  private async readCohortRecords(
    ownerUserId: string,
    candidates: readonly { id: string; score: string }[],
  ): Promise<Array<{
    state: 'missing' | 'legacy' | 'invalid' | 'present';
    routed: boolean;
    invalidReason?: PersistedMessageInvalidReason;
  }> | null> {
    if (candidates.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const candidate of candidates) {
      pipeline.hmget(
        MessageKeys.detail(candidate.id),
        'id',
        'threadId',
        'userId',
        'catId',
        'content',
        'mentions',
        'timestamp',
        'source',
        'routingFact',
        'provenance',
      );
    }
    const results = await pipeline.exec();
    if (!results || results.length !== candidates.length) return null;
    const records: Array<{
      state: 'missing' | 'legacy' | 'invalid' | 'present';
      routed: boolean;
      invalidReason?: PersistedMessageInvalidReason;
    }> = [];
    for (let index = 0; index < results.length; index += 1) {
      const entry = results[index];
      const candidate = candidates[index];
      const [err, value] = entry as [Error | null, unknown];
      if (err || !Array.isArray(value)) return null;
      const [storedId, threadId, userId, catId, content, mentions, timestamp, source, fact, provenance] =
        value as Array<string | null>;
      const parsed = parsePersistedMessageRecord({
        expectedId: candidate.id,
        expectedOwnerUserId: ownerUserId,
        expectedTimelineScore: candidate.score,
        id: storedId,
        threadId,
        userId,
        catId,
        content,
        mentions,
        timestamp,
        source,
        routingFact: fact,
        provenance,
      });
      records.push({
        state: parsed.state,
        routed:
          (parsed.state === 'present' && parsed.provenance.routed) ||
          (parsed.state === 'invalid' && parsed.reason === 'routing_fact_missing'),
        ...(parsed.state === 'invalid' ? { invalidReason: parsed.reason } : {}),
      });
    }
    return records;
  }

  /** Idempotent index repair: add missing members, drop stale ones. */
  private async repairIndex(
    indexKey: string,
    missing: readonly { id: string; score: string }[],
    stale: readonly string[],
  ): Promise<void> {
    if (missing.length === 0 && stale.length === 0) return;
    const repair = this.redis.multi();
    for (const entry of missing) {
      repair.zadd(indexKey, entry.score, entry.id);
    }
    for (const id of stale) {
      repair.zrem(indexKey, id);
    }
    // sol R1 P1-5: a swallowed repair failure would report a repaired window
    // that is still broken; throwing routes to reconcileWindow's ok:false path.
    assertExecResultsOk(await repair.exec(), 'repairIndex');
  }

  /**
   * §4.5.1②: authority-vs-projection reconcile over [fromTs, toTs].
   * Authority enumeration = owner message timeline (written in the same append
   * pipeline as the fact) filtered to hashes carrying a routingFact field.
   * Idempotent: repairs missing members, removes stale ones. Any Redis error →
   * { ok: false } and the caller must treat the window as unmeasurable.
   */
  async reconcileWindow(ownerUserId: string, fromTs: number, toTs: number): Promise<RoutingFactReconcileResult> {
    const failed: RoutingFactReconcileResult = {
      ok: false,
      reason: 'redis_error',
      cohortCount: 0,
      authorityCount: 0,
      producerGapCount: 0,
      projectedCount: 0,
      repairedMissing: 0,
      removedStale: 0,
    };
    try {
      const entries = await this.redis.zrangebyscore(MessageKeys.user(ownerUserId), fromTs, toTs, 'WITHSCORES');
      const candidates: Array<{ id: string; score: string }> = [];
      for (let i = 0; i + 1 < entries.length; i += 2) {
        candidates.push({ id: entries[i] as string, score: entries[i + 1] as string });
      }

      const records = await this.readCohortRecords(ownerUserId, candidates);
      if (records === null) {
        log.error({ ownerUserId }, 'routing-fact reconcile: authority read error');
        return failed;
      }

      // sol R3 P1-1: cohort membership comes from the PERSISTED provenance the
      // writer declared (routed axis) — never inferred from nullable fields and
      // never from fact presence. The append boundary enforces routed ⇔ fact
      // both ways (assertProvenanceConsistent), so a routed message without a
      // fact here means an out-of-band write or a broken producer = gap.
      // sol R4 P1-1c: a corrupt declaration anywhere in the window means the
      // cohort boundary itself is unknowable — bail to unmeasurable BEFORE
      // aggregating, instead of quietly treating the message as non-routed.
      const missingCount = records.filter((record) => record.state === 'missing').length;
      if (missingCount > 0) {
        log.error({ ownerUserId, missingCount }, 'routing-fact reconcile: indexed message hash missing');
        return { ...failed, reason: 'collection_gap' };
      }

      const declarationReasons: readonly PersistedMessageInvalidReason[] = [
        'malformed_provenance',
        'author_cat_id_conflict',
        'author_source_conflict',
        'routing_fact_unexpected',
      ];
      const malformedDeclarationCount = records.filter(
        (record) =>
          record.state === 'invalid' &&
          record.invalidReason !== undefined &&
          declarationReasons.includes(record.invalidReason),
      ).length;
      if (malformedDeclarationCount > 0) {
        log.error(
          { ownerUserId, malformedCount: malformedDeclarationCount },
          'routing-fact reconcile: malformed provenance in window',
        );
        return { ...failed, reason: 'malformed_provenance' };
      }

      const malformedFactCount = records.filter(
        (record) => record.state === 'invalid' && record.invalidReason === 'malformed_routing_fact',
      ).length;
      if (malformedFactCount > 0) {
        log.error({ ownerUserId, malformedFactCount }, 'routing-fact reconcile: malformed authority fact');
        return { ...failed, reason: 'malformed_authority_fact', malformedFactCount };
      }

      const malformedRecordCount = records.filter(
        (record) =>
          record.state === 'invalid' &&
          record.invalidReason !== 'routing_fact_missing' &&
          record.invalidReason !== 'malformed_routing_fact',
      ).length;
      if (malformedRecordCount > 0) {
        log.error({ ownerUserId, malformedRecordCount }, 'routing-fact reconcile: malformed authority record');
        return { ...failed, reason: 'malformed_record' };
      }

      const authority: Array<{ id: string; score: string }> = [];
      let cohortCount = 0;
      let producerGapCount = 0;
      for (let i = 0; i < candidates.length; i += 1) {
        const record = records[i];
        if (!record.routed) continue;
        cohortCount += 1;
        if (record.state === 'invalid' && record.invalidReason === 'routing_fact_missing') {
          producerGapCount += 1;
        } else {
          authority.push(candidates[i]);
        }
      }

      const indexKey = RoutingFactKeys.index(ownerUserId);
      const projected = new Set(await this.redis.zrangebyscore(indexKey, fromTs, toTs));
      const authorityIds = new Set(authority.map((entry) => entry.id));
      const missing = authority.filter((entry) => !projected.has(entry.id));
      const stale = [...projected].filter((id) => !authorityIds.has(id));

      await this.repairIndex(indexKey, missing, stale);
      if (missing.length > 0 || stale.length > 0) {
        log.info(
          { ownerUserId, repairedMissing: missing.length, removedStale: stale.length },
          'routing-fact projection reconciled',
        );
      }

      const base = {
        cohortCount,
        authorityCount: authority.length,
        producerGapCount,
        projectedCount: projected.size,
        repairedMissing: missing.length,
        removedStale: stale.length,
      };
      if (producerGapCount > 0) {
        log.error({ ownerUserId, producerGapCount, cohortCount }, 'routing-fact reconcile: producer gap in window');
        return { ok: false, reason: 'producer_gap', ...base };
      }
      return { ok: true, ...base };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact reconcile failed');
      return failed;
    }
  }

  /** T-A metric columns applied to one batch (mutates the matching mode aggregate). */
  private static applyBatch(
    modes: Record<RoutingParserMode, ModeAggregate>,
    batch: ReturnType<typeof safeParseRoutingFact>,
    counters: { excludedBatches: number; malformedFacts: number },
  ): void {
    const mode = batch ? modes[batch.parserMode] : undefined;
    if (!batch || !mode) {
      counters.malformedFacts += 1;
      return;
    }
    if (!batch.metricEligible) {
      counters.excludedBatches += 1;
      return;
    }
    mode.batches += 1;
    for (const attempt of batch.attempts) {
      if (!isMetricEligibleOutcome(attempt.outcome)) continue;
      mode.denominator += 1;
      if (isSuccessOutcome(attempt.outcome)) mode.numerator += 1;
    }
  }

  /**
   * V1 active metric: @解析成功率 per parserMode over a reconciled window.
   * Numerator/denominator/eligibility come from T-A via routing-attempt.ts
   * mapping functions. Reconcile failure → unmeasurable (§4.5.1②).
   */
  async computeResolutionRate(ownerUserId: string, fromTs: number, toTs: number): Promise<ResolutionRateResult> {
    const coverage = await this.reconcileWindow(ownerUserId, fromTs, toTs);
    if (!coverage.ok) {
      if (coverage.reason === 'malformed_authority_fact') {
        return {
          unmeasurable: true,
          reason: 'malformed_authority_fact',
          coverage,
          malformedFacts: coverage.malformedFactCount ?? 1,
        };
      }
      return {
        unmeasurable: true,
        reason: coverage.reason === 'producer_gap' ? 'producer_gap' : 'reconcile_failed',
        coverage,
      };
    }

    try {
      const ids = await this.redis.zrangebyscore(RoutingFactKeys.index(ownerUserId), fromTs, toTs);
      const payloads = await this.readFactPayloads(ids);
      if (payloads === null) return { unmeasurable: true, reason: 'read_failed' };

      const modes: Record<RoutingParserMode, ModeAggregate> = {
        a2a: { numerator: 0, denominator: 0, rate: null, batches: 0 },
        user: { numerator: 0, denominator: 0, rate: null, batches: 0 },
      };
      const counters = { excludedBatches: 0, malformedFacts: 0 };
      for (const payload of payloads) {
        RedisRoutingFactProjection.applyBatch(modes, safeParseRoutingFact(payload ?? undefined), counters);
      }
      // sol R1 P1-3: an authority fact that fails full validation means the
      // window's exact denominators cannot be trusted — no partial rate.
      if (counters.malformedFacts > 0) {
        return {
          unmeasurable: true,
          reason: 'malformed_authority_fact',
          coverage,
          malformedFacts: counters.malformedFacts,
        };
      }
      for (const mode of Object.values(modes)) {
        mode.rate = mode.denominator > 0 ? mode.numerator / mode.denominator : null;
      }

      return {
        unmeasurable: false,
        window: { fromTs, toTs },
        coverage,
        modes,
        excludedBatches: counters.excludedBatches,
        malformedFacts: counters.malformedFacts,
      };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact metric read failed');
      return { unmeasurable: true, reason: 'read_failed' };
    }
  }

  /** Collection-health snapshot for the Console badge (§4.5.1① + ③ visibility). */
  async getHealth(ownerUserId: string): Promise<{ ok: boolean; watermark: string | null; errorCount: number }> {
    try {
      const [watermark, errorCount] = await Promise.all([
        this.redis.get(RoutingFactKeys.watermark(ownerUserId)),
        this.redis.zcard(RoutingFactKeys.projectionErrors(ownerUserId)),
      ]);
      return { ok: true, watermark: watermark ?? null, errorCount };
    } catch (error) {
      log.error({ error, ownerUserId }, 'routing-fact health read failed');
      return { ok: false, watermark: null, errorCount: 0 };
    }
  }
}
