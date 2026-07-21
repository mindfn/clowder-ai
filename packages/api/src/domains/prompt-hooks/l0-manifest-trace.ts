/**
 * F257 #2 — L0 manifest → session trace adapter.
 *
 * Converts the per-segment L1-L7 manifest emitted by the ACTUAL L0 compiler
 * (`getL0ManifestViaSubprocess`) into a session `PipelineResult`, so the existing
 * trace bridge (`buildFromPipeline` → `eventsToSegments`) persists it as per-segment
 * `ObservedSegment`s — no second persistence format.
 *
 * Why this and not the (rejected) `collectNativeL0SessionTrace`: that reran the API
 * hook pipeline (a separate code path) and could report OVERRIDDEN L content the
 * override-blind native compiler never delivered. This adapter's input IS the compiled
 * artifact, so hash/char/token describe exactly what the provider received. Version is
 * the only field not in the artifact; it resolves from the hook registry (same source
 * the segment lifeline uses), defaulting to 1 for the always-on L hooks.
 */

import type { TraceEvent, TraceEventFired } from '@cat-cafe/shared';
import { estimateTokens } from '../../utils/token-counter.js';
import type { L0SegmentContent } from '../cats/services/agents/providers/l0-compiler.js';
import type { PipelineResult } from './HookPipeline.js';
import { getCachedRegistry } from './PipelinePromptBuilder.js';
import { hashContent } from './trace-collector.js';

/**
 * Build a session-stage `PipelineResult` from the real L0 compiler manifest.
 * Returns null for an empty manifest so callers can emit a visible "L not observed"
 * signal instead of persisting a silent healthy-zero.
 */
export function l0ManifestToSessionResult(manifest: readonly L0SegmentContent[]): PipelineResult | null {
  if (manifest.length === 0) return null;
  const registry = getCachedRegistry();
  const timestamp = Date.now();

  const patches = manifest.map((seg, i) => ({
    hookId: seg.segmentId,
    content: seg.content,
    order: (i + 1) * 100,
  }));

  const events: TraceEvent[] = manifest.map(
    (seg): TraceEventFired => ({
      hookId: seg.segmentId,
      stage: 'session-init',
      timestamp,
      status: 'fired',
      version: registry?.getHook(seg.segmentId)?.manifest.version ?? 1,
      contentHash: hashContent(seg.content),
      tokenEstimate: estimateTokens(seg.content),
    }),
  );

  return { patches, events };
}
