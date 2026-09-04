/**
 * F257 Phase D — Segment lifeline endpoint.
 *
 * Read-model join: InjectionTraceStore + GuardRejectionEventLog + HookOverrideStore
 * → version lifecycle chain response. CycleRecord truth is exposed by
 * segment-evaluation; legacy ObjectiveJudgment/MetricResult data is deliberately ignored.
 *
 * Zero new data collection — pure join of existing stores.
 * Auth: session-only (read surface, no mutation).
 */
import type { SafetyTier, SegmentEnablementMatrix, SegmentLifecycleResponse } from '@cat-cafe/shared';
import { resolveSegmentEnablementMatrix } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import { isFiredTraceSegment } from '../domains/prompt-hooks/injection-trace-semantics.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import {
  attributeGuardEventsToEpochs,
  buildVersionChain,
  deriveCurrentStatus,
  type SegmentObservationInput,
} from './segment-lifeline-chain.js';

export interface SegmentLifelineRoutesOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  overrideStore?: HookOverrideStore;
  /** Resolve manifest version for a segmentId. Returns 1 if unknown. */
  resolveManifestVersion?: (segmentId: string) => number;
  /** Resolve segment name from manifest. Returns segmentId if unknown. */
  resolveSegmentName?: (segmentId: string) => string;
  /**
   * F257 Console 判据⑥: resolve segment manifest constraints + backup state
   * needed to build the enablement matrix. Null when segment is unknown.
   */
  resolveSegmentManifest?: (segmentId: string) => {
    safetyTier: SafetyTier;
    allowLocalOverride: boolean;
    disableable: boolean;
    hasBackup: boolean;
  } | null;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap
/**
 * Cap on injected-content DETAIL rows only (sol R6 P1). Aggregate per-epoch
 * activity counts are computed from a full-window scan and are always exact.
 */
const MAX_OBSERVATIONS = 100;

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

/** Parse and validate windowMs query param. Returns null on invalid input. */
function parseWindowMs(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_WINDOW_MS);
}

export const segmentLifelineRoutes: FastifyPluginAsync<SegmentLifelineRoutesOptions> = async (app, opts) => {
  app.get('/api/segment-lifeline/:segmentId', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    if (!opts.traceStore) {
      return reply.status(503).send({ error: 'Trace store unavailable (redis off)' });
    }

    const { segmentId } = request.params as { segmentId: string };
    const query = request.query as { windowMs?: string };
    const windowMs = parseWindowMs(query.windowMs);
    if (windowMs === null) {
      return reply.status(400).send({ error: 'windowMs must be a finite positive number' });
    }
    const now = Date.now();
    const windowStart = now - windowMs;
    const windowEnd = now;

    const data = await assembleLifelineData(opts.traceStore, opts, segmentId, windowStart, windowEnd);
    const response = {
      segmentId,
      segmentName: data.segmentName,
      activeVersion: data.activeEpoch?.version ?? data.manifestVersion,
      chain: data.chain,
      currentStatus: deriveCurrentStatus(data.chain),
      window: { startMs: windowStart, endMs: windowEnd },
      // Retained for backward compat + detail views
      observations: data.observations,
      // P1 (sol R6): completeness provenance for the DETAIL list alone — true
      // when more matching rows existed than MAX_OBSERVATIONS. Aggregate
      // counts are exact regardless (full-window scan).
      observationsCapped: data.observationsCapped,
      guardEvents: data.guardEvents,
      overrideState: data.overrideState
        ? { hookId: segmentId, enabled: data.overrideState.enabled, contentVersion: data.overrideState.contentVersion }
        : null,
      epochGuardMetrics: data.epochGuardMetrics,
      enablementMatrix: data.enablementMatrix,
    } satisfies SegmentLifecycleResponse;

    return reply.send(response);
  });
};

// ── Read-model assembly ──────────────────────────────────────

interface LifelineData {
  segmentName: string;
  manifestVersion: number;
  chain: import('@cat-cafe/shared').VersionEpoch[];
  activeEpoch: import('@cat-cafe/shared').VersionEpoch | undefined;
  observations: SegmentObservation[];
  /** True when detail rows were dropped by MAX_OBSERVATIONS (counts stay exact). */
  observationsCapped: boolean;
  guardEvents: Array<{
    eventId: string;
    kind: string;
    threadId: string;
    catId: string;
    timestamp: number;
    guardId: string;
    attribution: 'window-correlated';
  }>;
  overrideState: { enabled: boolean; contentVersion: number | null } | null;
  epochGuardMetrics: Record<number, import('@cat-cafe/shared').GuardMetric[]>;
  enablementMatrix: SegmentEnablementMatrix;
}

/** Join trace, override, and guard stores into the version chain. */
async function assembleLifelineData(
  traceStore: InjectionTraceStore,
  opts: SegmentLifelineRoutesOptions,
  segmentId: string,
  windowStart: number,
  windowEnd: number,
): Promise<LifelineData> {
  // 1. Collect segment activity (full-window scan; fired detail list capped)
  const { observations, observationInputs, detailCapped } = await collectObservations(
    traceStore,
    segmentId,
    windowStart,
    windowEnd,
  );

  // 2. Collect override events for this segment
  const overrideEvents = opts.overrideStore ? await collectSegmentOverrideEvents(opts.overrideStore, segmentId) : [];

  // 3. Get current override state for contentVersion
  const overrideState = opts.overrideStore ? await getOverrideState(opts.overrideStore, segmentId) : null;

  // 4. Resolve manifest version. /api/segment-evaluation owns CycleRecord truth.
  const manifestVersion = opts.resolveManifestVersion?.(segmentId) ?? 1;
  const segmentName = opts.resolveSegmentName?.(segmentId) ?? segmentId;

  // 5. Build the version/tracing chain. Eval and governance content is rendered
  // from CycleRecord by /api/segment-evaluation, not synthesized here.
  const { chain, timeline } = buildVersionChain({
    manifestVersion,
    overrideEvents,
    observations: observationInputs,
    currentContentVersion: overrideState?.contentVersion ?? null,
  });

  // 6. Guard events — still collected for detail view
  const guardEvents = opts.guardRejectionLog
    ? await collectGuardEvents(opts.guardRejectionLog, windowStart, windowEnd, observations)
    : [];

  // 7. Attribute guard events to epochs using activation timeline (R15 P1)
  const epochGuardMetrics = attributeGuardEventsToEpochs(chain, timeline, guardEvents);

  const enablementMatrix = await buildLifelineEnablementMatrix(segmentId, opts, overrideState);

  return {
    segmentName,
    manifestVersion,
    chain,
    activeEpoch: chain.find((e) => e.isActive) ?? chain[chain.length - 1],
    observations,
    observationsCapped: detailCapped,
    guardEvents,
    overrideState,
    epochGuardMetrics,
    enablementMatrix,
  };
}

async function buildLifelineEnablementMatrix(
  segmentId: string,
  opts: SegmentLifelineRoutesOptions,
  overrideState: { enabled: boolean; contentVersion: number | null } | null,
): Promise<SegmentEnablementMatrix> {
  const manifestInfo = opts.resolveSegmentManifest?.(segmentId);
  const enabled = overrideState?.enabled ?? true;
  const hasOverride = overrideState !== null;
  const hasContentOverride = (overrideState?.contentVersion ?? null) !== null;

  let hasVersionSnapshot = false;
  const availableEpochVersions: number[] = [];
  if (opts.overrideStore && typeof opts.overrideStore.listVersions === 'function') {
    const versions = await opts.overrideStore.listVersions(segmentId);
    if (versions.length > 0) {
      hasVersionSnapshot = true;
      for (const v of versions) availableEpochVersions.push(v.version);
    }
  }

  return resolveSegmentEnablementMatrix({
    segmentId,
    safetyTier: manifestInfo?.safetyTier ?? 'readonly',
    allowLocalOverride: manifestInfo?.allowLocalOverride ?? false,
    disableable: manifestInfo?.disableable ?? false,
    localOverlay: { hasOverlay: false, hasBackup: manifestInfo?.hasBackup ?? false },
    runtimeOverride: {
      enabled,
      hasOverride,
      hasContentOverride,
      hasVersionSnapshot,
      availableEpochVersions,
    },
  });
}

// ── Data collection helpers ──────────────────────────────────

interface SegmentObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

/**
 * Collect activity for the segment within the window (sol R6 P1).
 *
 * Every matching segment row contributes to exact per-epoch activity counts,
 * including skipped and disabled rows. The replay DETAIL list is deliberately
 * injection-only and capped to the most recent MAX_OBSERVATIONS rows.
 */
async function collectObservations(
  store: InjectionTraceStore,
  segmentId: string,
  startMs: number,
  endMs: number,
): Promise<{
  observations: SegmentObservation[];
  observationInputs: SegmentObservationInput[];
  detailCapped: boolean;
}> {
  const threadIds = await store.listTracedThreadIds();
  const allRows: SegmentObservation[] = [];
  const observationInputs: SegmentObservationInput[] = [];

  for (const threadId of threadIds) {
    const summaries = await store.queryWindow(threadId, startMs, endMs);
    for (const summary of summaries) {
      const seg = summary.segments.find((s) => s.segmentId === segmentId);
      if (!seg) continue;
      const fired = isFiredTraceSegment(seg);
      observationInputs.push({
        timestamp: summary.timestamp,
        version: seg.version ?? null,
        fired,
        disabled: seg.pipelineStatus === 'disabled',
      });
      if (fired) {
        allRows.push({
          threadId: summary.threadId,
          turnId: summary.turnId,
          timestamp: summary.timestamp,
          catId: summary.catId,
          pipelineStatus: 'fired',
          version: seg.version ?? null,
          charCount: seg.charCount,
        });
      }
    }
  }

  allRows.sort((a, b) => b.timestamp - a.timestamp);
  return {
    observations: allRows.slice(0, MAX_OBSERVATIONS),
    observationInputs,
    detailCapped: allRows.length > MAX_OBSERVATIONS,
  };
}

/** ±120s proximity window for guard event attribution. */
const GUARD_PROXIMITY_MS = 120_000;

async function collectGuardEvents(
  log: GuardRejectionEventLog,
  startMs: number,
  endMs: number,
  observations: SegmentObservation[],
): Promise<
  Array<{
    eventId: string;
    kind: string;
    threadId: string;
    catId: string;
    timestamp: number;
    guardId: string;
    attribution: 'window-correlated';
  }>
> {
  if (observations.length === 0) return [];
  const events = await log.queryWindow({ since: startMs, until: endMs, limit: 50 });
  return events
    .filter((e) =>
      observations.some(
        (obs) =>
          obs.threadId === e.threadId &&
          obs.catId === e.catId &&
          Math.abs(obs.timestamp - e.timestamp) <= GUARD_PROXIMITY_MS,
      ),
    )
    .map((e) => ({
      eventId: e.eventId,
      kind: e.kind,
      threadId: e.threadId,
      catId: e.catId,
      timestamp: e.timestamp,
      guardId: e.guardId,
      attribution: 'window-correlated' as const,
    }));
}

async function collectSegmentOverrideEvents(
  store: HookOverrideStore,
  segmentId: string,
): Promise<import('@cat-cafe/shared').OverrideChangeEvent[]> {
  // Chain needs full history for this segment.
  // HookOverrideStore.listEvents() has no hookId filter — fetch all and filter.
  // Ceiling of 10000 covers any realistic lifetime event count.
  const allEvents = await store.listEvents({ limit: 10000 });
  return allEvents.filter((e) => e.hookId === segmentId);
}

async function getOverrideState(
  store: HookOverrideStore,
  segmentId: string,
): Promise<{ enabled: boolean; contentVersion: number | null } | null> {
  const overrides = await store.listOverrides();
  const match = overrides.find((o) => o.hookId === segmentId);
  if (!match) return null;
  return {
    enabled: match.enabled !== false,
    contentVersion: match.contentVersion ?? null,
  };
}
