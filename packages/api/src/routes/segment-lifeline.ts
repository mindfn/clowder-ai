/**
 * F257 Phase D — Segment lifeline endpoint.
 *
 * Read-model join: InjectionTraceStore + GuardRejectionEventLog + HookOverrideStore
 * → structured lifeline response consumed by the Console segment lifeline modal.
 *
 * Zero new data collection — pure join of existing stores.
 * Auth: session-only (read surface, no mutation).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';

export interface SegmentLifelineRoutesOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  overrideStore?: HookOverrideStore;
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

    // 1. Discover all threads with trace data, query each for this window
    const observations = await collectObservations(opts.traceStore, segmentId, windowStart, windowEnd);

    // 2. Guard rejection events — filtered to threads with observations for this segment
    // (P2-2 fix: unfiltered query caused cross-thread event leakage — terra review)
    const observationThreadIds = new Set(observations.map((o) => o.threadId));
    const guardEvents = opts.guardRejectionLog
      ? await collectGuardEvents(opts.guardRejectionLog, windowStart, windowEnd, observationThreadIds)
      : [];

    // 3. Override state and history
    const { overrideState, overrideHistory } = opts.overrideStore
      ? await collectOverrideData(opts.overrideStore, segmentId, windowStart, windowEnd)
      : { overrideState: null, overrideHistory: [] };

    // 4. Derive status
    const latestVersion = deriveLatestVersion(observations);
    const status = observations.length > 0 ? 'tracing' : 'idle';

    return reply.send({
      segmentId,
      status,
      currentVersion: latestVersion,
      window: { startMs: windowStart, endMs: windowEnd },
      observations,
      guardEvents,
      overrideState,
      overrideHistory,
    });
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
): Promise<SegmentObservation[]> {
  const threadIds = await store.listTracedThreadIds();
  const observations: SegmentObservation[] = [];

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
      if (observations.length >= MAX_OBSERVATIONS) break;
    }
  }

  // Sort by timestamp descending (most recent first)
  observations.sort((a, b) => b.timestamp - a.timestamp);
  return observations;
}

async function collectGuardEvents(
  log: GuardRejectionEventLog,
  startMs: number,
  endMs: number,
  relevantThreadIds: Set<string>,
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
  const events = await log.queryWindow({ since: startMs, until: endMs, limit: 50 });
  return events
    .filter((e) => relevantThreadIds.has(e.threadId))
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

async function collectOverrideData(
  store: HookOverrideStore,
  segmentId: string,
  startMs: number,
  endMs: number,
): Promise<{
  overrideState: { hookId: string; enabled: boolean } | null;
  overrideHistory: Array<{
    eventId: string;
    hookId: string;
    action: string;
    source: string;
    timestamp: number;
    actorId: string;
    reason: string;
  }>;
}> {
  // Current override state — the hookId is the segmentId for hook-backed segments
  const overrides = await store.listOverrides();
  const match = overrides.find((o) => o.hookId === segmentId);
  const overrideState = match ? { hookId: match.hookId, enabled: match.enabled !== false } : null;

  // Override change events for this segment
  const allEvents = await store.listEvents({ since: startMs, until: endMs, limit: 50 });
  const segmentEvents = allEvents
    .filter((e) => e.hookId === segmentId)
    .map((e) => ({
      eventId: e.eventId,
      hookId: e.hookId,
      action: e.action,
      source: e.source,
      timestamp: e.timestamp,
      actorId: e.actorId,
      reason: e.reason ?? '',
    }));

  return { overrideState, overrideHistory: segmentEvents };
}

function deriveLatestVersion(observations: SegmentObservation[]): number | null {
  for (const obs of observations) {
    if (obs.version != null) return obs.version;
  }
  return null;
}
