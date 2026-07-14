/**
 * F257 Phase D — Segment lifeline endpoint.
 *
 * Read-model join: InjectionTraceStore + GuardRejectionEventLog + HookOverrideStore
 * + SegmentJudgmentCache → version lifecycle chain response.
 *
 * Zero new data collection — pure join of existing stores.
 * Auth: session-only (read surface, no mutation).
 */
import type { SegmentLifecycleResponse } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import type { SegmentJudgmentCache } from '../domains/prompt-hooks/SegmentJudgmentCache.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import { buildVersionChain, deriveCurrentStatus, type SegmentObservationInput } from './segment-lifeline-chain.js';

export interface SegmentLifelineRoutesOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  overrideStore?: HookOverrideStore;
  judgmentCache?: SegmentJudgmentCache;
  /** Resolve manifest version for a segmentId. Returns 1 if unknown. */
  resolveManifestVersion?: (segmentId: string) => number;
  /** Resolve segment name from manifest. Returns segmentId if unknown. */
  resolveSegmentName?: (segmentId: string) => string;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap
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

    // 1. Collect raw observations
    const { observations, observationInputs } = await collectObservations(
      opts.traceStore,
      segmentId,
      windowStart,
      windowEnd,
    );

    // 2. Collect override events for this segment
    const overrideEvents = opts.overrideStore ? await collectSegmentOverrideEvents(opts.overrideStore, segmentId) : [];

    // 3. Get current override state for contentVersion
    const overrideState = opts.overrideStore ? await getOverrideState(opts.overrideStore, segmentId) : null;

    // 4. Get cached judgment
    const cachedJudgment = opts.judgmentCache ? await opts.judgmentCache.get(segmentId) : null;

    // 5. Resolve manifest version
    const manifestVersion = opts.resolveManifestVersion?.(segmentId) ?? 1;
    const segmentName = opts.resolveSegmentName?.(segmentId) ?? segmentId;

    // 6. Build version lifecycle chain
    const chain = buildVersionChain({
      manifestVersion,
      overrideEvents,
      observations: observationInputs,
      cachedJudgment,
      currentContentVersion: overrideState?.contentVersion ?? null,
    });

    // 7. Guard events — still collected for detail view
    const guardEvents = opts.guardRejectionLog
      ? await collectGuardEvents(opts.guardRejectionLog, windowStart, windowEnd, observations)
      : [];

    const response = {
      segmentId,
      segmentName,
      activeVersion: chain.find((e) => e.isActive)?.version ?? manifestVersion,
      chain,
      currentStatus: deriveCurrentStatus(chain),
      window: { startMs: windowStart, endMs: windowEnd },
      // Retained for backward compat + detail views
      observations,
      guardEvents,
      overrideState: overrideState
        ? { hookId: segmentId, enabled: overrideState.enabled, contentVersion: overrideState.contentVersion }
        : null,
    } satisfies SegmentLifecycleResponse & Record<string, unknown>;

    return reply.send(response);
  });
};

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

async function collectObservations(
  store: InjectionTraceStore,
  segmentId: string,
  startMs: number,
  endMs: number,
): Promise<{ observations: SegmentObservation[]; observationInputs: SegmentObservationInput[] }> {
  const threadIds = await store.listTracedThreadIds();
  const observations: SegmentObservation[] = [];
  const observationInputs: SegmentObservationInput[] = [];

  for (const threadId of threadIds) {
    if (observations.length >= MAX_OBSERVATIONS) break;
    const summaries = await store.queryWindow(threadId, startMs, endMs);
    for (const summary of summaries) {
      const seg = summary.segments.find((s) => s.segmentId === segmentId && s.status === 'observed');
      if (!seg) continue;
      observations.push({
        threadId: summary.threadId,
        turnId: summary.turnId,
        timestamp: summary.timestamp,
        catId: summary.catId,
        pipelineStatus: seg.pipelineStatus ?? 'observed',
        version: seg.version ?? null,
        charCount: seg.charCount,
      });
      observationInputs.push({
        timestamp: summary.timestamp,
        version: seg.version ?? null,
      });
      if (observations.length >= MAX_OBSERVATIONS) break;
    }
  }

  observations.sort((a, b) => b.timestamp - a.timestamp);
  return { observations, observationInputs };
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
