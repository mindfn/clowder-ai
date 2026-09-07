import { existsSync, statSync } from 'node:fs';
import { readJsonKey } from '../lib/redis.mjs';
import { combine, fail, pass, unbound } from '../lib/report.mjs';
import { CYCLE_RECORD_SURFACE } from './f2-f3.mjs';
import { checkCycleCoordinates } from './f6-cycle-coordinates.mjs';
import { readCycle } from './f7-f4.mjs';

export const CONSOLE_ENTRY = '/settings?s=rules → 生命周期与注入 → 回合构建 → <segment> 📊';

// S4 @ 096a9ec46 projected CycleRecord only. PR #152 (TC-12 rewrite) collapsed the trigger face to the
// segment's single Objective (`tracing.trigger.objective`) and counts the owner linear pool (TC-1);
// PR #155 bound every detail panel to an exact cycle (`selectedCycle`, `?cycleId=`).
const STATES = new Set(['idle', 'requested', 'retriggered', 'written', 'stalled']);
const ROUTES = new Set(['cumulative', 'counterexamples', 'cadence']);
const LIFECYCLES = new Set(['active', 'dormant', 'retired']);
const HEALTH = new Set(['healthy', 'zero-trace-fault']);
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 8;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LEGACY_FIELDS = [
  'unclassifiedEpisodeCount',
  'latestJudgment',
  'collection',
  'pendingTowardTrigger',
  'perObjective',
];
const LEGACY_TRIGGER_SUMMARY = [
  'traceCount',
  'traceRequired',
  'windowMs',
  'counterexampleCount',
  'counterexampleRequired',
];
const COUNTEREXAMPLE_REF_FIELDS = new Set([
  'annotationId',
  'incidentKey',
  'objectiveId',
  'metricId',
  'source',
  'createdAt',
  'rationale',
  'threadId',
  'turnId',
  'catId',
]);
const isInt = (value) => Number.isInteger(value);

function findKeys(value, names, path = '$', hits = []) {
  if (Array.isArray(value)) value.forEach((item, index) => findKeys(item, names, `${path}[${index}]`, hits));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (names.includes(key)) hits.push(`${path}.${key}`);
      findKeys(child, names, `${path}.${key}`, hits);
    }
  }
  return hits;
}

function laneProblems(lane) {
  const problems = [];
  if (typeof lane.objectiveId !== 'string') problems.push('objectiveId');
  if (!STATES.has(lane.evalStatus)) problems.push('evalStatus');
  if (!LIFECYCLES.has(lane.lifecycle)) problems.push('lifecycle (TC-18)');
  if (!HEALTH.has(lane.health)) problems.push('health (F-11)');
  if (!isInt(lane.policyChangeCount) || lane.policyChangeCount < 0) problems.push('policyChangeCount (TC-9 audit)');
  if (!isInt(lane.cycleStartMs)) problems.push('cycleStartMs');
  if (!(lane.cycleEndMs === null || isInt(lane.cycleEndMs))) problems.push('cycleEndMs');
  if (!Array.isArray(lane.triggeredBy) || !lane.triggeredBy.every((route) => ROUTES.has(route)))
    problems.push('triggeredBy');
  for (const group of ['cumulative', 'counterexamples']) {
    const value = lane[group] ?? {};
    if (!isInt(value.count) || value.count < 0 || !isInt(value.threshold) || value.threshold <= 0) problems.push(group);
  }
  const cadence = lane.cadence ?? {};
  if (!isInt(cadence.elapsedMs) || cadence.elapsedMs < 0) problems.push('cadence.elapsedMs');
  if (!isInt(cadence.thresholdMs) || cadence.thresholdMs <= 0 || cadence.thresholdMs % DAY_MS !== 0)
    problems.push('cadence.thresholdMs');
  if (cadence.eligible !== lane.cumulative?.count > 0) problems.push('cadence.eligible must equal cumulative.count>0');
  return problems;
}

function cycleParity(lane, record) {
  const problems = [];
  if (lane.evalStatus !== record.evalStatus) problems.push(`evalStatus ${lane.evalStatus} ≠ ${record.evalStatus}`);
  if (lane.cycleStartMs !== record.cycleStart)
    problems.push(`cycleStartMs ${lane.cycleStartMs} ≠ ${record.cycleStart}`);
  if (lane.cycleEndMs !== (record.cycleEnd ?? null))
    problems.push(`cycleEndMs ${lane.cycleEndMs} ≠ ${record.cycleEnd ?? null}`);
  if (JSON.stringify(lane.triggeredBy) !== JSON.stringify(record.triggeredBy ?? []))
    problems.push('triggeredBy differs');
  return problems;
}

function objectiveProblems(view, record, historyCount) {
  const problems = [];
  if (!Array.isArray(view.metrics) || view.metrics.length === 0) problems.push('metrics catalog empty');
  for (const metric of view.metrics ?? []) {
    for (const field of ['metricId', 'label', 'kind', 'evaluatorKind', 'evaluatorRuleRef'])
      if (typeof metric[field] !== 'string') problems.push(`metric.${field}`);
    if (!metric.verdictRule || !('latestConclusion' in metric) || !Array.isArray(metric.evidenceRefs))
      problems.push(`metric ${metric.metricId}: verdictRule/latestConclusion/evidenceRefs`);
  }
  if (!('latestEvaluation' in view) || !('latestGovernance' in view) || !Array.isArray(view.versionChain))
    problems.push('latestEvaluation/latestGovernance/versionChain missing');
  if (!('selectedCycle' in view)) problems.push('selectedCycle missing (PR #155 exact-cycle binding)');
  const expectedChain = Math.min(historyCount, HISTORY_LIMIT) + (record ? 1 : 0);
  if ((view.versionChain ?? []).length !== expectedChain)
    problems.push(
      `versionChain ${view.versionChain?.length} ≠ history(${historyCount}, cap ${HISTORY_LIMIT}) + current`,
    );
  for (const cycle of view.versionChain ?? [])
    if (!isInt(cycle.ordinal) || cycle.ordinal < 1)
      problems.push(`cycle ${cycle.cycleId?.slice(0, 14)} lacks a truthful global ordinal`);
  if (!record) return problems;
  if (view.currentCycle?.cycleId !== record.cycleId) problems.push('currentCycle ≠ CycleRecord');
  if (view.selectedCycle?.cycleId !== record.cycleId) problems.push('default selectedCycle ≠ live cycle');
  if (view.versionChain?.at(-1)?.cycleId !== record.cycleId) problems.push('versionChain tail ≠ current cycle');
  if (view.versionChain?.at(-1)?.ordinal !== historyCount + 1)
    problems.push(`current ordinal ≠ history count + 1 (${historyCount + 1})`);
  if (record.evaluation) {
    if (
      view.latestEvaluation?.cycleId !== record.cycleId ||
      view.latestEvaluation?.writtenAt !== record.evaluation.writtenAt
    )
      problems.push('latestEvaluation ≠ current CycleRecord.evaluation');
    const written = new Map(record.evaluation.metrics.map((metric) => [metric.id, metric]));
    for (const metric of view.metrics) {
      const source = written.get(metric.metricId);
      if (source && JSON.stringify(metric.latestConclusion) !== JSON.stringify(source.conclusion))
        problems.push(`metric ${metric.metricId} conclusion ≠ CycleRecord`);
    }
  } else if (view.latestEvaluation)
    problems.push('latestEvaluation shown for an unevaluated live cycle (borrowed conclusion)');
  if (record.governance) {
    const latest = view.latestGovernance;
    if (
      latest?.cycleId !== record.cycleId ||
      latest?.decision !== record.governance.decision ||
      latest?.by !== record.governance.by
    )
      problems.push('latestGovernance ≠ current CycleRecord.governance');
  } else if (view.latestGovernance)
    problems.push('latestGovernance shown for a cycle without governance (borrowed decision)');
  return problems;
}

async function readProjectedRecord(redis, options) {
  const current = await readCycle(redis, options);
  if (current.record) return current;
  const [cycleId] = await redis.zrevrange(CYCLE_RECORD_SURFACE.historyIndexFor(options), 0, 0);
  if (!cycleId) return { key: current.key, record: null };
  const key = CYCLE_RECORD_SURFACE.historyFor({ ...options, cycleId });
  return { key, record: await readJsonKey(redis, key) };
}

export async function checkF6({ api, redis, keyPrefix, ownerUserId, segmentId, objectiveId, browserEvidencePath }) {
  const endMs = Date.now();
  const startMs = endMs - 30 * DAY_MS;
  const path = `/api/segment-evaluation/${encodeURIComponent(segmentId)}?startMs=${startMs}&endMs=${endMs}`;
  const { status, body } = await api.getJson(path);
  if (status !== 200 || !body || typeof body !== 'object')
    return fail('F-6', `segment-evaluation returned ${status} for ${segmentId}`, { status, body });
  const parts = [];
  const bytes = Buffer.byteLength(JSON.stringify(body));
  parts.push(
    bytes < MAX_RESPONSE_BYTES
      ? pass('F-6', `read model ${bytes} B`)
      : fail('F-6', `read model ${bytes} B ≥ 64 KB (trace bodies?)`),
  );
  const legacy = [...findKeys(body, LEGACY_FIELDS), ...findKeys(body.tracing?.trigger ?? {}, LEGACY_TRIGGER_SUMMARY)];
  parts.push(
    legacy.length === 0
      ? pass('F-6', 'no 待分类 / 旧三数字 / perObjective / judgment-era fields')
      : fail('F-6', 'legacy projection fields still present (TC-12)', { legacy }),
  );
  const leaks = (body.tracing?.structuredCounterexamples ?? []).flatMap((entry) =>
    Object.keys(entry).filter((key) => !COUNTEREXAMPLE_REF_FIELDS.has(key)),
  );
  parts.push(
    leaks.length === 0
      ? pass('F-6', 'counterexample list carries references only')
      : fail('F-6', `counterexample entries carry non-reference fields: ${[...new Set(leaks)].join(',')}`),
  );
  const lane = body.tracing?.trigger?.objective;
  if (!lane || typeof lane !== 'object')
    return combine('F-6', [...parts, fail('F-6', 'trigger.objective missing (TC-12: one Objective lane per segment)')]);
  const shape = laneProblems(lane);
  parts.push(
    shape.length === 0
      ? pass(
          'F-6',
          `lane ${lane.objectiveId}: cumulative m/N + counterexamples n/M + cadence d/D + lifecycle/health + cycle start`,
        )
      : fail('F-6', 'trigger.objective lane shape mismatch', { shape }),
  );
  const objectives = body.objectives ?? [];
  const view = objectives[0];
  if (objectives.length !== 1 || !view || view.objectiveId !== lane.objectiveId || lane.objectiveId !== objectiveId)
    return combine('F-6', [
      ...parts,
      fail('F-6', `expected exactly one Objective (${objectiveId}) for ${segmentId}`, {
        lane: lane.objectiveId,
        objectives: objectives.map((entry) => entry.objectiveId),
      }),
    ]);
  const { key, record } = await readProjectedRecord(redis, { keyPrefix, ownerUserId, objectiveId });
  if (!record) return combine('F-6', [...parts, fail('F-6', `no CycleRecord for ${objectiveId}`, { key })]);
  const parity = cycleParity(lane, record);
  parts.push(
    parity.length === 0
      ? pass('F-6', `lane ${objectiveId} == CycleRecord (${record.evalStatus}, start ${record.cycleStart})`)
      : fail('F-6', 'lane disagrees with CycleRecord', { key, parity }),
  );
  // TC-1: cumulative counts the owner linear pool over the projected window (countOwnerWindow: zcount start..end-1).
  const windowEnd = body.window?.end ?? record.cycleEnd ?? endMs;
  const pooled = await redis.zcount(`${keyPrefix}trace-owner-episode:${ownerUserId}`, record.cycleStart, windowEnd - 1);
  parts.push(
    pooled === lane.cumulative.count
      ? pass(
          'F-6',
          `cumulative ${lane.cumulative.count}/${lane.cumulative.threshold} == owner linear pool over [${record.cycleStart}, ${windowEnd})`,
        )
      : fail(
          'F-6',
          `cumulative ${lane.cumulative.count} ≠ owner pool ${pooled} over [${record.cycleStart}, ${windowEnd})`,
        ),
  );
  const historyCount = await redis.zcard(CYCLE_RECORD_SURFACE.historyIndexFor({ keyPrefix, ownerUserId, objectiveId }));
  const objective = objectiveProblems(view, record, historyCount);
  parts.push(
    objective.length === 0
      ? pass(
          'F-6',
          `objective view: ${view.metrics.length} metrics; latestEvaluation ${view.latestEvaluation ? `${view.latestEvaluation.overall}@${view.latestEvaluation.cycleId.slice(0, 14)}` : 'none (no fake state)'}; latestGovernance ${view.latestGovernance ? `${view.latestGovernance.decision}/${view.latestGovernance.approval?.state ?? 'no card'}` : 'none'}; cycles ${view.versionChain.length}`,
        )
      : fail('F-6', 'objective view disagrees with CycleRecord / history', { objective }),
  );
  parts.push(...(await checkCycleCoordinates({ api, redis, keyPrefix, segmentId, body, startMs, endMs })));
  if (browserEvidencePath && existsSync(browserEvidencePath)) {
    const stat = statSync(browserEvidencePath);
    parts.push(pass('F-6', `browser pass recorded: ${browserEvidencePath} (${stat.size} B)`, { mtime: stat.mtimeMs }));
  } else {
    parts.push(unbound('F-6', `browser pass pending (Playwright, manual): ${CONSOLE_ENTRY}`));
  }
  return combine('F-6', parts);
}
