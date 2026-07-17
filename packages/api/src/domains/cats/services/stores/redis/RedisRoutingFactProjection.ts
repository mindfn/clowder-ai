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
import { safeParseRoutingFact } from './redis-message-parsers.js';

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
  authorityCount: number;
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
  | { unmeasurable: true; reason: 'reconcile_failed' | 'read_failed' }
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
    if (!fact || fact.attempts.length === 0) return;
    try {
      const pipeline = this.redis.multi();
      pipeline.zadd(RoutingFactKeys.index(msg.userId), String(msg.timestamp), msg.id);
      await pipeline.exec();
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
    await repair.exec();
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
      authorityCount: 0,
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

      const payloads = await this.readFactPayloads(candidates.map((candidate) => candidate.id));
      if (payloads === null) {
        log.error({ ownerUserId }, 'routing-fact reconcile: authority read error');
        return failed;
      }
      const authority = candidates.filter((_, i) => payloads[i] !== null);

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

      return {
        ok: true,
        authorityCount: authority.length,
        projectedCount: projected.size,
        repairedMissing: missing.length,
        removedStale: stale.length,
      };
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
    if (!coverage.ok) return { unmeasurable: true, reason: 'reconcile_failed' };

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
