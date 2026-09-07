import { readJsonKey } from '../lib/redis.mjs';
import { fail, pass, unbound } from '../lib/report.mjs';

// terminal-contract §4 F-6 supplement (TC-12 @ eac31822a + 2193221af): every tracing/eval/governance
// coordinate binds to one exact Objective cycle, version ancestry is a tree, and a cycle belongs to the
// segment version named by its own CycleRecord.versionContentRef — never to "whichever version was
// active at cycleStart" (cycleStart = previous trigger time, always earlier than the previous apply).

const LIVE_STATES = new Set(['idle', 'requested', 'retriggered', 'stalled']);

/** Parse a CycleRecord.versionContentRef into the segment's version coordinate (pure, both schemes). */
export function parseSegmentVersionRef(ref, segmentId) {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith('hook-versions:')) {
    for (const entry of ref.slice('hook-versions:'.length).split(',')) {
      const [unit, raw] = entry.trim().split('@');
      if (unit === segmentId && /^\d+$/.test(raw ?? '')) return { scheme: 'hook-versions', version: Number(raw) };
    }
    return { scheme: 'hook-versions', version: null };
  }
  if (ref.startsWith('harness-objective-version:')) return { scheme: 'objective-version', key: ref };
  return null;
}

/** Resolve the segment version a cycle evaluated, reading the objective-version snapshot when needed. */
export async function resolveSegmentVersion(redis, keyPrefix, ref, segmentId) {
  const parsed = parseSegmentVersionRef(ref, segmentId);
  if (!parsed) return null;
  if (parsed.scheme === 'hook-versions') return parsed.version;
  const snapshot = await readJsonKey(redis, `${keyPrefix}${parsed.key}`);
  const unit = (snapshot?.units ?? []).find(
    (entry) => entry?.manifest?.id === segmentId || entry?.unitId === segmentId,
  );
  return Number.isInteger(unit?.activeContentVersion) ? unit.activeContentVersion : null;
}

export async function checkCycleCoordinates({ api, redis, keyPrefix, segmentId, body, startMs, endMs }) {
  const parts = [];
  const base = `/api/segment-evaluation/${encodeURIComponent(segmentId)}?startMs=${startMs}&endMs=${endMs}`;
  const view = body.objectives?.[0];
  const chain = view?.versionChain ?? [];

  const bogus = await api.getJson(`${base}&cycleId=cycle-does-not-exist`);
  parts.push(
    bogus.status === 404
      ? pass('F-6', 'unknown cycleId → 404 (no silent fallback to another cycle)')
      : fail('F-6', `unknown cycleId returned ${bogus.status}, expected 404`),
  );

  const history = chain.filter((cycle) => cycle.closedAt != null);
  if (history.length === 0) parts.push(unbound('F-6', 'exact-cycle binding: no closed cycle in history yet'));
  else {
    const target = history[0];
    const { status, body: bound } = await api.getJson(`${base}&cycleId=${encodeURIComponent(target.cycleId)}`);
    const objective = bound?.objectives?.[0];
    const problems = [];
    if (status !== 200) problems.push(`status ${status}`);
    if (objective?.selectedCycle?.cycleId !== target.cycleId) problems.push('selectedCycle ≠ requested cycleId');
    if (objective?.latestEvaluation && objective.latestEvaluation.cycleId !== target.cycleId)
      problems.push('latestEvaluation leaked from another cycle');
    if (objective?.latestGovernance && objective.latestGovernance.cycleId !== target.cycleId)
      problems.push('latestGovernance leaked from another cycle');
    if (bound?.tracing?.trigger?.objective?.cycleStartMs !== target.cycleStart)
      problems.push('trigger lane not rebound to the selected cycle');
    if (objective?.currentCycle?.cycleId !== view?.currentCycle?.cycleId)
      problems.push('currentCycle changed by selection (live coordinate must stay separate)');
    parts.push(
      problems.length === 0
        ? pass('F-6', `history cycle ${target.cycleId.slice(0, 14)} binds eval / governance / trigger exactly`)
        : fail('F-6', 'exact-cycle binding broken', { cycleId: target.cycleId, problems }),
    );
  }

  const current = view?.currentCycle;
  if (current && LIVE_STATES.has(current.evalStatus) && view.selectedCycle?.cycleId === current.cycleId) {
    const leak =
      (view.latestEvaluation && view.latestEvaluation.cycleId !== current.cycleId) ||
      (view.latestGovernance && view.latestGovernance.cycleId !== current.cycleId);
    parts.push(
      leak
        ? fail('F-6', "unevaluated live cycle shows another cycle's conclusions")
        : pass('F-6', `live cycle (${current.evalStatus}) shows the metric catalog only, no borrowed conclusions`),
    );
  }

  const lifeline = await api.getJson(`/api/segment-lifeline/${encodeURIComponent(segmentId)}`);
  if (lifeline.status !== 200) parts.push(fail('F-6', `segment-lifeline returned ${lifeline.status}`));
  else {
    const epochs = lifeline.body?.chain ?? [];
    const malformed = epochs.filter(
      (epoch) => !(epoch.parentVersion === null || Number.isInteger(epoch.parentVersion)),
    );
    const activations = lifeline.body?.versionActivations;
    parts.push(
      malformed.length === 0 && Array.isArray(activations)
        ? pass(
            'F-6',
            `lifeline: ${epochs.length} epoch(s) carry parentVersion; ${activations.length} activation point(s)`,
          )
        : fail('F-6', 'lifeline lacks parentVersion / versionActivations', {
            malformed: malformed.map((epoch) => epoch.version),
            activations: Array.isArray(activations),
          }),
    );
  }

  const resolved = [];
  for (const cycle of chain) {
    resolved.push({
      cycleId: cycle.cycleId,
      ordinal: cycle.ordinal ?? null,
      fromRef: await resolveSegmentVersion(redis, keyPrefix, cycle.versionContentRef, segmentId),
      projected: cycle.segmentVersion,
    });
  }
  const unresolved = resolved.filter((entry) => entry.fromRef === null);
  if (unresolved.length > 0)
    parts.push(
      fail('F-6', 'versionContentRef does not resolve to a segment version', {
        unresolved: unresolved.map((entry) => entry.cycleId.slice(0, 14)),
      }),
    );
  const truth = resolved.map((entry) => `${entry.ordinal ?? '?'}:v${entry.fromRef}`);
  if (resolved.length > 0 && resolved.every((entry) => entry.projected === undefined))
    parts.push(
      unbound('F-6', 'cycle→version attribution (segmentVersion) not projected yet — TC-12 @ 2193221af fix pending', {
        truth,
      }),
    );
  else if (resolved.length > 0) {
    const mismatch = resolved.filter((entry) => entry.projected !== entry.fromRef);
    parts.push(
      mismatch.length === 0
        ? pass('F-6', `cycle→version attribution equals CycleRecord ref for all ${resolved.length} cycle(s)`, { truth })
        : fail('F-6', 'projected segmentVersion ≠ CycleRecord ref (first cycle after evolve misfiled?)', { mismatch }),
    );
  }
  return parts;
}
