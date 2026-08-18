/**
 * TraceBootstrap — F237 (Trace v0)
 *
 * Module-level singleton for InjectionTraceStore.
 * Bootstrapped once at server startup when Redis is available.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { EvaluationCatalog } from '../../infrastructure/harness-eval/evaluation/evaluation-catalog.js';
import { ObjectiveEvaluationRuntime } from '../../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import { PendingTraceMarkerStore } from '../../infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.js';
import { resolvePendingTraceMarkers } from '../../infrastructure/harness-eval/trace-annotation/resolve-pending-markers.js';
import { SemanticSweepCoordinator } from '../../infrastructure/harness-eval/trace-annotation/SemanticSweepCoordinator.js';
import { SemanticSweepJobStore } from '../../infrastructure/harness-eval/trace-annotation/SemanticSweepJobStore.js';
import { deriveStructuredTraceAnnotations } from '../../infrastructure/harness-eval/trace-annotation/structured-rule-tagger.js';
import { TraceAnnotationStore } from '../../infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { InjectionTraceStore } from './InjectionTraceStore.js';

let _redis: RedisClient | null = null;
let _traceStore: InjectionTraceStore | null = null;
let _markerStore: PendingTraceMarkerStore | null = null;
let _annotationStore: TraceAnnotationStore | null = null;
let _evaluationRuntime: ObjectiveEvaluationRuntime | null = null;
let _semanticSweepCoordinator: SemanticSweepCoordinator | null = null;

/** Bootstrap the trace store singleton. Call once at server startup. */
export function bootstrapTraceStore(redis: RedisClient): void {
  _redis = redis;
  _traceStore = new InjectionTraceStore(redis);
  _markerStore = new PendingTraceMarkerStore(redis);
  _annotationStore = new TraceAnnotationStore(redis);
}

export function bootstrapObjectiveEvaluationRuntime(redis: RedisClient, catalog: EvaluationCatalog): void {
  if (!_annotationStore) throw new Error('trace_store_must_be_bootstrapped_first');
  _evaluationRuntime = new ObjectiveEvaluationRuntime(redis, catalog, _annotationStore);
}

export function bootstrapSemanticSweepCoordinator(redis: RedisClient, messageStore: IMessageStore): void {
  if (!_traceStore || !_evaluationRuntime) throw new Error('objective_evaluation_runtime_must_be_bootstrapped_first');
  _semanticSweepCoordinator = new SemanticSweepCoordinator({
    traceStore: _traceStore,
    jobStore: new SemanticSweepJobStore(redis),
    annotationSink: _evaluationRuntime,
    catalog: _evaluationRuntime.catalog,
    async hydrateContext(episode) {
      const ids = [episode.terminal.inputMessageId, episode.terminal.outputMessageId].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      const messages = ids.length > 0 ? await messageStore.getByIds(ids) : [];
      const owned = messages.filter(
        (message) => message.userId === episode.terminal.ownerUserId && message.threadId === episode.terminal.threadId,
      );
      const byId = new Map(owned.map((message) => [message.id, message]));
      const truncate = (value: string | undefined): string | null =>
        value === undefined ? null : value.length <= 2_000 ? value : `${value.slice(0, 2_000)}\n…[truncated]`;
      const inputMessage = episode.terminal.inputMessageId ? byId.get(episode.terminal.inputMessageId) : undefined;
      const surrounding = inputMessage
        ? await messageStore.getByThreadBefore(
            episode.terminal.threadId,
            inputMessage.timestamp + 1,
            8,
            undefined,
            episode.terminal.ownerUserId,
          )
        : [];
      return {
        episode,
        inputText: truncate(
          episode.terminal.inputMessageId ? byId.get(episode.terminal.inputMessageId)?.content : undefined,
        ),
        outputText: truncate(
          episode.terminal.outputMessageId ? byId.get(episode.terminal.outputMessageId)?.content : undefined,
        ),
        contextMessages: surrounding
          .filter(
            (message) =>
              message.userId === episode.terminal.ownerUserId &&
              message.threadId === episode.terminal.threadId &&
              !message.deletedAt,
          )
          .map((message) => ({
            messageId: message.id,
            catId: message.catId,
            content:
              message.content.length <= 1_200 ? message.content : `${message.content.slice(0, 1_200)}\n…[truncated]`,
          })),
      };
    },
  });
}

/** Get the bootstrapped trace store (null if Redis unavailable). */
export function getTraceStore(): InjectionTraceStore | null {
  return _traceStore;
}

export function getTraceEvaluationStores(): {
  traceStore: InjectionTraceStore;
  markerStore: PendingTraceMarkerStore;
  annotationStore: TraceAnnotationStore;
  annotationSink?: Pick<TraceAnnotationStore, 'append'>;
} | null {
  if (!_traceStore || !_markerStore || !_annotationStore) return null;
  return {
    traceStore: _traceStore,
    markerStore: _markerStore,
    annotationStore: _annotationStore,
    ...(_evaluationRuntime ? { annotationSink: _evaluationRuntime } : {}),
  };
}

export function getObjectiveEvaluationRuntime(): ObjectiveEvaluationRuntime | null {
  return _evaluationRuntime;
}

export function getSemanticSweepCoordinator(): SemanticSweepCoordinator | null {
  return _semanticSweepCoordinator;
}

export async function resolvePendingMarkersForInvocation(invocationId: string): Promise<void> {
  const stores = getTraceEvaluationStores();
  if (!stores) return;
  await resolvePendingTraceMarkers({ invocationId, ...stores });
}

// ---------------------------------------------------------------------------
// F257: Volume-based SemanticSweep auto-trigger
// ---------------------------------------------------------------------------
// When unclassified episode count in the 7-day window reaches the threshold
// AND the owner has no active claim (atomic SET NX EX), automatically trigger
// a semantic sweep via the eval cat.
//
// Design rationale: most metrics are semantic and cannot be classified by
// structured rules alone. Without this trigger, unclassified episodes
// accumulate silently until a manual or cadence trigger runs. Volume-based
// triggering bridges the gap — when a user is actively working, the system
// automatically sweeps after enough data accumulates.
//
// Architecture: The volume check is lightweight (Redis ZCOUNT on 7-day
// window + atomic SET NX EX claim). When conditions are met, it delegates
// to a late-bound callback that drives the full eval cat invocation pipeline
// (handleTriggerNow). This keeps trace-bootstrap decoupled from the
// invocation/message/thread dependencies.
//
// Coordination: Owner-scoped Redis key + per-owner in-process debounce.
// Follows the same SET NX EX + release-on-failure pattern as
// guard-threshold-escalation.ts (sol R3 P1-1 prior art).
// ---------------------------------------------------------------------------

/** @internal Exported for testing only. */
export const SWEEP_VOLUME_THRESHOLD = 200;
/** @internal Exported for testing only. */
export const SWEEP_MIN_INTERVAL_SECONDS = 6 * 60 * 60; // 6 hours
/** @internal Exported for testing only — Redis key prefix (owner-scoped). */
export const SWEEP_CLAIM_KEY_PREFIX = 'harness-semantic-sweep-auto-claim:';
/** 7-day window matching handleTriggerNow / SemanticSweepCoordinator.prepare */
const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-owner in-process debounce — prevents concurrent checks for the SAME owner. */
const _sweepChecksInFlight = new Set<string>();

/**
 * Late-bound callback for invoking the eval cat when volume conditions are met.
 * Returns { dispatched: true } only when the eval cat was actually invoked;
 * all other outcomes (skip, error, queue-full) return { dispatched: false }.
 * Wired during server startup (index.ts) with handleTriggerNow deps.
 */
export type VolumeSweepInvokeCallback = (ownerUserId: string) => Promise<{ dispatched: boolean }>;
let _volumeSweepInvoke: VolumeSweepInvokeCallback | null = null;

/** Bind the eval cat invocation callback. Called once during server startup. */
export function bindVolumeSweepInvoke(cb: VolumeSweepInvokeCallback): void {
  _volumeSweepInvoke = cb;
}

/**
 * Check whether volume-based sweep conditions are met and trigger if so.
 * Called fire-and-forget after each trace persistence. Conditions:
 *   1. unclassified episode count in 7-day window ≥ SWEEP_VOLUME_THRESHOLD
 *   2. owner has no active claim (atomic SET NX EX with 6h TTL)
 * Both must hold simultaneously. Owner-scoped: user A's trigger never
 * suppresses user B.
 */
export async function checkAndTriggerVolumeSweep(ownerUserId: string): Promise<void> {
  if (_sweepChecksInFlight.has(ownerUserId)) return; // per-owner debounce
  const traceStore = _traceStore;
  if (!traceStore || !_volumeSweepInvoke || !_redis) return;

  _sweepChecksInFlight.add(ownerUserId);
  try {
    // Count unclassified episodes in the SAME 7-day window that
    // handleTriggerNow / SemanticSweepCoordinator.prepare uses.
    const now = Date.now();
    const count = await traceStore.countUnclassified(ownerUserId, now - SWEEP_WINDOW_MS, now + 1);
    if (count < SWEEP_VOLUME_THRESHOLD) return;

    // Atomic claim via SET NX EX — only one concurrent caller wins.
    // Owner-scoped key: user A's claim never suppresses user B.
    // Pattern: guard-threshold-escalation.ts SET NX EX prior art.
    const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}${ownerUserId}`;
    const claimValue = JSON.stringify({ claimedAt: now, count });
    const claimed = await _redis.set(claimKey, claimValue, 'EX', SWEEP_MIN_INTERVAL_SECONDS, 'NX');
    if (claimed !== 'OK') return; // Another caller already claimed — dedup

    // Delegate to late-bound invoke callback (wired in index.ts via
    // handleTriggerNow for eval:harness-ledger domain).
    // Release claim on failure so next check can retry — only confirmed
    // dispatch keeps the 6h TTL claim (same invariant as threshold escalation).
    const result = await _volumeSweepInvoke(ownerUserId);
    if (!result.dispatched) {
      try {
        await _redis.del(claimKey);
      } catch {
        // DEL failure → TTL backstop auto-expires in 6h (bounded degradation)
      }
    }
  } catch {
    // Fire-and-forget: sweep trigger failure must not break invocation path.
    // Claim (if acquired) auto-expires via TTL — bounded degradation.
  } finally {
    _sweepChecksInFlight.delete(ownerUserId);
  }
}

export async function annotateStructuredRulesForInvocation(invocationId: string): Promise<void> {
  const stores = getTraceEvaluationStores();
  if (!stores) return;
  const episode = await stores.traceStore.getEpisodeByInvocationId(invocationId);
  if (!episode) return;
  const annotations = deriveStructuredTraceAnnotations(episode);
  for (const annotation of annotations) {
    await (stores.annotationSink ?? stores.annotationStore).append(annotation);
  }
  if (annotations.length > 0) {
    await stores.traceStore.markEpisodeClassified(episode.terminal.ownerUserId, invocationId);
  }
}
