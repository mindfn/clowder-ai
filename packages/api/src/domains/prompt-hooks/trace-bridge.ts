/**
 * F257 Trace Persistence Bridge — Phase A Line B
 *
 * Adapts pipeline-produced PipelineResult (per-hook TraceEvent[])
 * into v0 InjectionTraceSummary / InjectionTraceDetail formats
 * consumed by InjectionTraceStore.
 *
 * Replaces the redundant v0 collectTrace() path which re-invoked
 * buildStaticIdentity(annotateSegments: true) on every turn.
 * The pipeline already produces richer per-hook data at drain time;
 * this bridge converts it to the v0 persistence format.
 *
 * When pipeline traces are unavailable (e.g., legacy path or native
 * L0 without pipeline), callers fall back to the existing v0 path.
 */

import type {
  DeliveryChannel,
  InjectionTraceDetail,
  InjectionTraceSummary,
  ObservedSegment,
  StageDeliveryDecision,
  TraceEvent,
} from '@cat-cafe/shared';
import type { PipelineResult } from './HookPipeline.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TraceBridgeMeta {
  turnId: string;
  sessionId?: string;
  threadId: string;
  catId: string;
  hasNativeL0: boolean;
}

/**
 * Build v0 InjectionTraceSummary + InjectionTraceDetail from pipeline results.
 *
 * Returns null when both session and turn results are null (no pipeline
 * traces captured — caller should fall back to v0 collectTrace path).
 */
export function buildFromPipeline(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  meta: TraceBridgeMeta,
): { summary: InjectionTraceSummary; detail: InjectionTraceDetail } | null {
  if (!sessionResult && !turnResult) return null;

  const sessionSegments = sessionResult ? eventsToSegments(sessionResult, 'session-init') : [];
  const turnSegments = turnResult ? eventsToSegments(turnResult, 'per-turn') : [];
  const allSegments = [...sessionSegments, ...turnSegments];

  const observed = allSegments.filter((s) => s.status === 'observed');
  const absent = allSegments.filter((s) => s.status === 'absent');

  const sessionTokens = sumTokens(sessionSegments);
  const turnTokens = sumTokens(turnSegments);
  const sessionChars = sumChars(sessionResult);
  const turnChars = sumChars(turnResult);

  const delivery = buildDelivery(sessionResult, turnResult, meta.hasNativeL0);
  const timestamp = Date.now();

  const summary: InjectionTraceSummary = {
    turnId: meta.turnId,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    segments: allSegments,
    delivery,
    totalCharCount: sessionChars + turnChars,
    totalTokenEstimate: sessionTokens + turnTokens,
    totalSegmentsObserved: observed.length,
    totalSegmentsAbsent: absent.length,
    durationMs: 0, // Pipeline doesn't track duration; 0 = not measured
  };

  const detail: InjectionTraceDetail = {
    turnId: meta.turnId,
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    sessionContentHash: firstFiredHash(sessionResult),
    turnContentHash: firstFiredHash(turnResult),
    sessionCharCount: sessionChars,
    sessionTokenEstimate: sessionTokens,
    turnCharCount: turnChars,
    turnTokenEstimate: turnTokens,
    segments: allSegments,
  };

  return { summary, detail };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type InjectionStage = 'session-init' | 'per-turn';

/** Convert pipeline TraceEvent[] to v0 ObservedSegment[]. */
function eventsToSegments(result: PipelineResult, stage: InjectionStage): ObservedSegment[] {
  const patchMap = new Map(result.patches.map((p) => [p.hookId, p]));
  return result.events.map((ev): ObservedSegment => {
    if (ev.status === 'fired') {
      const patch = patchMap.get(ev.hookId);
      return {
        segmentId: ev.hookId,
        stage,
        status: 'observed',
        contentHash: ev.contentHash,
        charCount: patch?.content.length ?? 0,
        tokenEstimate: ev.tokenEstimate,
      };
    }
    // skipped / disabled / observed-without-content
    return {
      segmentId: ev.hookId,
      stage,
      status: 'absent',
      contentHash: null,
      charCount: 0,
      tokenEstimate: 0,
    };
  });
}

function sumTokens(segments: ObservedSegment[]): number {
  return segments.reduce((acc, s) => acc + s.tokenEstimate, 0);
}

function sumChars(result: PipelineResult | null): number {
  if (!result) return 0;
  return result.patches.reduce((acc, p) => acc + p.content.length, 0);
}

/** Get content hash of assembled content (first non-empty patch hash, or null). */
function firstFiredHash(result: PipelineResult | null): string | null {
  if (!result) return null;
  const fired = result.events.find(
    (ev): ev is TraceEvent & { status: 'fired'; contentHash: string } => ev.status === 'fired',
  );
  return fired?.contentHash ?? null;
}

function buildDelivery(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  hasNativeL0: boolean,
): StageDeliveryDecision[] {
  const sessionChannel: DeliveryChannel = hasNativeL0 ? 'pack-only' : 'message-prepend';
  return [
    {
      stage: 'session-init' as InjectionStage,
      contentAssembled: sessionResult !== null && sessionResult.patches.length > 0,
      channel: sessionChannel,
      reason: hasNativeL0
        ? 'Pipeline bridge: pack-only for native L0'
        : 'Pipeline bridge: content assembled for message-prepend',
    },
    {
      stage: 'per-turn' as InjectionStage,
      contentAssembled: turnResult !== null && turnResult.patches.length > 0,
      channel: 'message-prepend',
      reason: 'Pipeline bridge: per-turn content assembled',
    },
  ];
}
