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
// When unclassified episode count reaches the threshold AND at least
// SWEEP_MIN_INTERVAL_MS has passed since the last sweep, automatically
// trigger a semantic sweep via the eval cat.
//
// Design rationale: most metrics are semantic and cannot be classified by
// structured rules alone. Without this trigger, unclassified episodes
// accumulate silently until a manual or cadence trigger runs. Volume-based
// triggering bridges the gap — when a user is actively working, the system
// automatically sweeps after enough data accumulates.
//
// Architecture: The volume check is lightweight (Redis ZCARD + GET). When
// conditions are met, it delegates to a late-bound callback that drives the
// full eval cat invocation pipeline (handleTriggerNow). This keeps trace-
// bootstrap decoupled from the invocation/message/thread dependencies.
// ---------------------------------------------------------------------------

const SWEEP_VOLUME_THRESHOLD = 200;
const SWEEP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SWEEP_LAST_TRIGGER_KEY = 'harness-semantic-sweep-last-auto-trigger';

let _sweepCheckInFlight = false;

/**
 * Late-bound callback for invoking the eval cat when volume conditions are met.
 * Wired during server startup (index.ts) with the full invocation pipeline deps
 * — specifically handleTriggerNow for eval:harness-ledger.
 */
type VolumeSweepInvokeCallback = (ownerUserId: string) => Promise<void>;
let _volumeSweepInvoke: VolumeSweepInvokeCallback | null = null;

/** Bind the eval cat invocation callback. Called once during server startup. */
export function bindVolumeSweepInvoke(cb: VolumeSweepInvokeCallback): void {
  _volumeSweepInvoke = cb;
}

/**
 * Check whether volume-based sweep conditions are met and trigger if so.
 * Called fire-and-forget after each trace persistence. Conditions:
 *   1. unclassified episode count ≥ SWEEP_VOLUME_THRESHOLD
 *   2. time since last auto-triggered sweep ≥ SWEEP_MIN_INTERVAL_MS
 * Both must hold simultaneously.
 */
export async function checkAndTriggerVolumeSweep(ownerUserId: string): Promise<void> {
  if (_sweepCheckInFlight) return; // debounce concurrent checks
  const traceStore = _traceStore;
  if (!traceStore || !_volumeSweepInvoke) return;

  _sweepCheckInFlight = true;
  try {
    const count = await traceStore.countUnclassified(ownerUserId);
    if (count < SWEEP_VOLUME_THRESHOLD) return;

    if (!_redis) return;
    const lastTriggerRaw = await _redis.get(SWEEP_LAST_TRIGGER_KEY);
    const lastTriggerAt = lastTriggerRaw ? Number(lastTriggerRaw) : 0;
    const now = Date.now();
    if (now - lastTriggerAt < SWEEP_MIN_INTERVAL_MS) return;

    // Both conditions met — record trigger time BEFORE invoke to prevent
    // re-trigger during the async invocation window
    await _redis.set(SWEEP_LAST_TRIGGER_KEY, String(now));

    // Delegate to late-bound invoke callback (wired in index.ts via
    // handleTriggerNow for eval:harness-ledger domain)
    await _volumeSweepInvoke(ownerUserId);
  } catch {
    // Fire-and-forget: sweep trigger failure must not break invocation path
  } finally {
    _sweepCheckInFlight = false;
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
