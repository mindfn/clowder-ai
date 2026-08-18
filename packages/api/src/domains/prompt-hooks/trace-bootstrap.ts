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
// Architecture: lightweight Redis ZCOUNT + SET NX EX claim. When conditions
// are met, delegates to a late-bound callback (handleTriggerNow). This keeps
// trace-bootstrap decoupled from invocation/message/thread dependencies.
//
// Coordination model (completion-driven drain, fenced by jobId):
//   Phase 1 — Initial trigger: count ≥ 200 in 7-day window → claim → dispatch
//             batch of 10 → enter drain mode → shorten claim TTL → store jobId.
//   Phase 2 — Drain: when eval cat classifies the batch (submit-semantic-sweep
//             calls advanceVolumeSweepDrain with jobId), the claim is released
//             IFF the jobId matches the active drain's jobId (fenced), then
//             checkAndTriggerVolumeSweep is called to dispatch the next batch.
//             Drain auto-exits when count reaches 0 or max rounds (25).
//             Claim TTL during drain is a safety timeout (10 min).
//
// No in-process debounce — sole dedup is Redis SET NX EX (sol R2 P1-1).
// Completion-driven drain + jobId fencing (sol R4 P1).
// ---------------------------------------------------------------------------

/** @internal Exported for testing. */
export const SWEEP_VOLUME_THRESHOLD = 200;
/** @internal Exported for testing. */
export const SWEEP_MIN_INTERVAL_SECONDS = 6 * 60 * 60; // 6 hours
/** @internal Exported for testing — owner-scoped Redis key prefix. */
export const SWEEP_CLAIM_KEY_PREFIX = 'harness-semantic-sweep-auto-claim:';
/** @internal Exported for testing — drain mode Redis key prefix. */
export const SWEEP_DRAIN_KEY_PREFIX = 'harness-semantic-sweep-drain:';
/** @internal Exported for testing. */
export const SWEEP_DRAIN_INTERVAL_SECONDS = 10 * 60; // 10 min between drain batches
/** @internal Exported for testing. */
export const SWEEP_DRAIN_TTL_SECONDS = 20 * 60; // 20 min (refreshed each round)
/** @internal Exported for testing. */
export const SWEEP_MAX_DRAIN_ROUNDS = 25; // Safety cap (~250 episodes)
/** Coordinator default prepare() limit — each dispatch processes this many. */
export const SWEEP_BATCH_SIZE = 10;
/** 7-day window matching handleTriggerNow / SemanticSweepCoordinator.prepare */
const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Late-bound callback for invoking the eval cat when volume conditions are met.
 * Returns { dispatched, jobId } — jobId is the SemanticSweepCoordinator job
 * that was prepared, used to fence the completion-driven drain release.
 * Wired during server startup (index.ts) with handleTriggerNow deps.
 */
export type VolumeSweepInvokeCallback = (ownerUserId: string) => Promise<{ dispatched: boolean; jobId?: string }>;
let _volumeSweepInvoke: VolumeSweepInvokeCallback | null = null;

/** Bind the eval cat invocation callback. Called once during server startup. */
export function bindVolumeSweepInvoke(cb: VolumeSweepInvokeCallback): void {
  _volumeSweepInvoke = cb;
}

// -- Helpers (extracted for cognitive complexity — sol R3 P2) --

type DrainState = { round: number; startedAt: number; jobId?: string };

/** Resolve current drain state from Redis. */
async function resolveDrainState(redis: RedisClient, ownerUserId: string): Promise<DrainState | null> {
  const raw = await redis.get(`${SWEEP_DRAIN_KEY_PREFIX}${ownerUserId}`);
  return raw ? JSON.parse(raw) : null;
}

/** Decide whether volume sweep should fire based on count and drain state. */
function shouldTriggerSweep(count: number, drain: DrainState | null): 'trigger' | 'skip' | 'drain_exit' {
  if (count === 0) return drain ? 'drain_exit' : 'skip';
  if (drain && drain.round >= SWEEP_MAX_DRAIN_ROUNDS) return 'drain_exit';
  if (!drain && count < SWEEP_VOLUME_THRESHOLD) return 'skip';
  return 'trigger';
}

/** Update drain lifecycle after successful dispatch (sol R3/R4 fix). */
async function manageDrainAfterDispatch(
  redis: RedisClient,
  ownerUserId: string,
  count: number,
  drain: DrainState | null,
  now: number,
  jobId?: string,
): Promise<void> {
  const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}${ownerUserId}`;
  if (count > SWEEP_BATCH_SIZE) {
    const round = drain ? drain.round + 1 : 1;
    // Shorten claim to drain interval — advanceVolumeSweepDrain (called by
    // submit-semantic-sweep on batch completion) releases early. This TTL is
    // the safety timeout if the completion hook never fires.
    await redis.set(
      `${SWEEP_CLAIM_KEY_PREFIX}${ownerUserId}`,
      JSON.stringify({ shortenedAt: now, drain: true }),
      'EX',
      SWEEP_DRAIN_INTERVAL_SECONDS,
    );
    // Store jobId for fenced release — only this job's completion can release
    await redis.set(
      drainKey,
      JSON.stringify({ round, startedAt: drain?.startedAt ?? now, jobId }),
      'EX',
      SWEEP_DRAIN_TTL_SECONDS,
    );
  } else if (drain) {
    // Last batch fits in one sweep — drain complete
    await redis.del(drainKey);
  }
}

/**
 * Check whether volume-based sweep conditions are met and trigger if so.
 * Called fire-and-forget after each trace persistence, and internally by
 * advanceVolumeSweepDrain after batch completion (the wake mechanism).
 */
export async function checkAndTriggerVolumeSweep(ownerUserId: string): Promise<void> {
  if (!_traceStore || !_volumeSweepInvoke || !_redis) return;
  const redis = _redis;

  try {
    const now = Date.now();
    const count = await _traceStore.countUnclassified(ownerUserId, now - SWEEP_WINDOW_MS, now + 1);
    const drain = await resolveDrainState(redis, ownerUserId);
    const decision = shouldTriggerSweep(count, drain);

    if (decision === 'skip') return;
    if (decision === 'drain_exit') {
      await redis.del(`${SWEEP_DRAIN_KEY_PREFIX}${ownerUserId}`);
      return;
    }

    // Atomic claim via SET NX EX — only one concurrent caller wins.
    // Normal mode: 6h cooldown. Drain mode: shorter TTL (safety timeout —
    // completion hook releases early via advanceVolumeSweepDrain).
    const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}${ownerUserId}`;
    const claimTtl = drain ? SWEEP_DRAIN_INTERVAL_SECONDS : SWEEP_MIN_INTERVAL_SECONDS;
    const claimed = await redis.set(
      claimKey,
      JSON.stringify({ claimedAt: now, count, drain: !!drain }),
      'EX',
      claimTtl,
      'NX',
    );
    if (claimed !== 'OK') return;

    const result = await _volumeSweepInvoke(ownerUserId);
    if (!result.dispatched) {
      await redis.del(claimKey).catch(() => {});
      return;
    }

    await manageDrainAfterDispatch(redis, ownerUserId, count, drain, now, result.jobId);
  } catch {
    // Fire-and-forget: claim auto-expires via TTL — bounded degradation.
  }
}

/**
 * Advance volume sweep drain after a semantic sweep batch completes.
 * Called from submit-semantic-sweep.ts after coordinator.submit().
 *
 * Fenced by jobId (sol R4 P1-2): only releases the claim if completedJobId
 * matches the drain key's jobId. Manual/guard sweeps or idempotent replays
 * with a different jobId are no-ops — they cannot release a volume claim.
 *
 * After fenced release, directly calls checkAndTriggerVolumeSweep to
 * dispatch the next batch (sol R4 P1-1: the wake mechanism).
 */
export async function advanceVolumeSweepDrain(ownerUserId: string, completedJobId: string): Promise<void> {
  if (!_redis) return;
  try {
    const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}${ownerUserId}`;
    const drainRaw = await _redis.get(drainKey);
    if (!drainRaw) return; // No active drain — not a volume-triggered batch
    const drain: DrainState = JSON.parse(drainRaw);
    if (drain.jobId && drain.jobId !== completedJobId) return; // Fenced: wrong job

    await _redis.del(`${SWEEP_CLAIM_KEY_PREFIX}${ownerUserId}`);
    await checkAndTriggerVolumeSweep(ownerUserId);
  } catch {
    // Bounded degradation: claim TTL auto-expires, next trace check retries
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
