/**
 * F257 #2 — native-L0 session trace persistence (shared by route-serial + route-parallel).
 *
 * Persists the L1-L7 session trace from the ACTUAL L0 compiler manifest
 * (`getL0ManifestViaSubprocess`), bridged through the existing `buildFromPipeline`.
 *
 * Fully fire-and-forget: call WITHOUT awaiting so it never taxes the model critical
 * path (sol 2b R1 P2-1). The manifest is cache-first; a cold cache shares the provider's
 * own compile via the l0-compiler in-flight dedup — no redundant full-stage run. An empty
 * manifest emits a visible producer warning rather than silently persisting D-only, so
 * "L 系列无数据" is distinguishable from a healthy zero.
 *
 * Centralizing here (vs. inlining in two large route functions) is also sol 2b R1 P2-2:
 * one producer seam, unit-testable without driving a whole route.
 */

import type { InjectionTraceDetail, InjectionTraceSummary } from '@cat-cafe/shared';
import { getL0ManifestViaSubprocess } from '../cats/services/agents/providers/l0-compiler.js';
import type { PipelineResult } from './HookPipeline.js';
import { l0ManifestToSessionResult } from './l0-manifest-trace.js';
import { buildFromPipeline } from './trace-bridge.js';

interface TraceSink {
  persist(summary: InjectionTraceSummary, detail: InjectionTraceDetail): Promise<void>;
}

interface TraceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface PersistNativeL0Params {
  traceStore: TraceSink;
  catId: string;
  threadId: string;
  turnId: string;
  /** The already-drained per-turn (D-series) pipeline trace for this invocation. */
  turnResult: PipelineResult | null;
  log: TraceLogger;
}

export async function persistNativeL0SessionTrace(params: PersistNativeL0Params): Promise<void> {
  const { traceStore, catId, threadId, turnId, turnResult, log } = params;
  try {
    const manifest = await getL0ManifestViaSubprocess({ catId });
    const sessionResult = l0ManifestToSessionResult(manifest);
    if (!sessionResult) {
      log.warn(
        { catId, threadId },
        '[F257] native L0 manifest empty — L1-L7 not observed this turn (compile did not run / produced no manifest)',
      );
    }
    const bridge = buildFromPipeline(sessionResult, turnResult, {
      turnId,
      threadId,
      catId,
      hasNativeL0: true,
      sessionFromNativeCompiler: sessionResult !== null,
    });
    if (bridge) {
      await traceStore.persist(bridge.summary, bridge.detail);
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), catId, threadId },
      '[F257] native L0 session trace failed (fire-and-forget)',
    );
  }
}
