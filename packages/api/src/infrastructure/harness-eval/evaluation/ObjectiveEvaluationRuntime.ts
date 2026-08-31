import { createHash } from 'node:crypto';
import type {
  EvaluationSnapshot,
  JudgmentCommittedEvent,
  MetricDefinition,
  MetricResult,
  MetricResultValue,
  MetricVerdictDecision,
  MetricVerdictRule,
  ObjectiveJudgment,
  ObjectiveVerdictDecision,
  SegmentVerdict,
  TraceAnnotation,
} from '@cat-cafe/shared';
import { SEGMENT_VERDICTS } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { classifyMetrics, EvaluationScheduler, type UnitTraceCorpusReader } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { ExternalSemanticResultStore } from './ExternalSemanticResultStore.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { EvaluatorRunner, type ReplayEvaluator, type SemanticEvaluator } from './evaluator-runner.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const METRIC_DECISION_STATUSES = new Set<MetricVerdictDecision['status']>([
  'breach',
  'clean',
  'inconclusive',
  'insufficient_evidence',
  'unavailable',
]);

const UNIT_RUN_PENDING_PREFIX = 'harness-unit-run-pending:';
const UNIT_RUN_WATERMARK_PREFIX = 'harness-unit-run-watermark:';
const UNIT_RUN_CADENCE_WATERMARK_PREFIX = 'harness-unit-run-cadence-watermark:';
const UNIT_RUN_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';

const pendingKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_PENDING_PREFIX}${ownerUserId}:${objectiveId}`;
const watermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_WATERMARK_PREFIX}${ownerUserId}:${objectiveId}`;
const cadenceWatermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_CADENCE_WATERMARK_PREFIX}${ownerUserId}:${objectiveId}`;
const completedWindowEndKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_COMPLETED_WINDOW_END_PREFIX}${ownerUserId}:${objectiveId}`;

/**
 * F257 P1-1/P1-2: Atomic claim of a Unit run.
 *
 * The pending key stores the full UnitRun as JSON so a later retry can resume
 * the same immutable snapshot even if `now` has advanced. If the watermark has
 * moved past the expected cursor, any pending is stale and is cleared.
 */
const CLAIM_UNIT_RUN_LUA = `
-- @fake-redis-handler: claimUnitRun
local pendingRaw = redis.call('GET', KEYS[1])
if pendingRaw ~= false then
  local pending = cjson.decode(pendingRaw)
  if pending.snapshotId ~= ARGV[1] then return 0 end
  if tostring(pending.expectedWatermark) ~= ARGV[2] then
    redis.call('DEL', KEYS[1])
    return 0
  end
  return 1
end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;

/**
 * F257 P1-1 / R10: Atomic commit of a Unit run.
 *
 * All durable side effects (results, judgment, consumed annotations, ingestion
 * cursor, cadence watermark) are written inside one Lua script. Redis executes
 * the script atomically, but a runtime error inside the script does NOT roll
 * back writes that have already executed. To prevent partial commits, we
 * preflight every target key type before performing any writes. If any key has
 * the wrong type, the script returns -1 and leaves nothing written.
 *
 * Large cohorts are added to the consumed set with a Lua loop instead of
 * unpack(), which fails with "too many results to unpack" for ~8000+ items.
 */
const COMMIT_UNIT_RUN_LUA = `
-- @fake-redis-handler: commitUnitRun
-- KEYS layout:
--   [1] pending key
--   [2] ingestion watermark key
--   [3] cadence watermark key
--   [4] consumed-annotation set key
--   [5] completed-snapshot-index zset key
--   [6] completed-window-end string key
--   [7..7 + resultCount*2 - 1] result payload key, result index key pairs
--   [7 + resultCount*2] judgment payload key
--   [8 + resultCount*2] judgment index key
-- ARGV layout:
--   [1] snapshotId
--   [2] new ingestion watermark (maxAnnotationScore)
--   [3] expected ingestion watermark (windowStartScore)
--   [4] new cadence watermark (evaluatedAt)
--   [5] new completed window end
--   [6] JSON array of [resultJson, resultScore, resultId]
--   [7] JSON array of [judgmentJson, judgmentScore, judgmentId]
--   [8] JSON array of annotationIds
local pendingRaw = redis.call('GET', KEYS[1])
if pendingRaw == false then return 0 end
local pending = cjson.decode(pendingRaw)
if pending.snapshotId ~= ARGV[1] then return 0 end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[3] then
  redis.call('DEL', KEYS[1])
  return 0
end

local resultEntries = cjson.decode(ARGV[6])
local judgmentEntry = cjson.decode(ARGV[7])
local annotationIds = cjson.decode(ARGV[8])

-- Preflight all target keys before any writes. Wrong types would cause a
-- runtime error mid-script and leave a partial commit behind. Each key role
-- has a precise allowed type set so a string-typed index key is caught before
-- ZADD would fail. All keys are passed through KEYS so the Redis client can
-- apply its keyPrefix consistently.
local function checkStringOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'string' or t == 'none'
end
local function checkZsetOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'zset' or t == 'none'
end
local function checkSetOrNone(key)
  local t = redis.call('TYPE', key)['ok']
  return t == 'set' or t == 'none'
end

for i = 7, 7 + #resultEntries * 2 - 1, 2 do
  if not checkStringOrNone(KEYS[i]) then return -1 end
  if not checkZsetOrNone(KEYS[i + 1]) then return -1 end
end
local judgmentKeyIdx = 7 + #resultEntries * 2
if not checkStringOrNone(KEYS[judgmentKeyIdx]) then return -1 end
if not checkZsetOrNone(KEYS[judgmentKeyIdx + 1]) then return -1 end
if not checkSetOrNone(KEYS[4]) then return -1 end
if not checkZsetOrNone(KEYS[5]) then return -1 end
if not checkStringOrNone(KEYS[2]) then return -1 end
if not checkStringOrNone(KEYS[3]) then return -1 end
if not checkStringOrNone(KEYS[6]) then return -1 end

for i = 1, #resultEntries do
  local keyIdx = 7 + (i - 1) * 2
  redis.call('SET', KEYS[keyIdx], resultEntries[i][1], 'NX')
  redis.call('ZADD', KEYS[keyIdx + 1], resultEntries[i][2], resultEntries[i][3])
end

redis.call('SET', KEYS[judgmentKeyIdx], judgmentEntry[1], 'NX')
redis.call('ZADD', KEYS[judgmentKeyIdx + 1], judgmentEntry[2], judgmentEntry[3])

for i = 1, #annotationIds do
  redis.call('SADD', KEYS[4], annotationIds[i])
end

redis.call('ZADD', KEYS[5], ARGV[2], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[6], ARGV[5])
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * F257 conclusion→governance seam: post-commit hook fired after every SUCCESSFUL
 * Unit-run commit. Modeled on GuardRejectionEventLog.setPostAppendHook.
 * Implementations must be fail-open (the emit site awaits it inside try/catch).
 */
export type JudgmentCommittedHook = (event: JudgmentCommittedEvent) => void | Promise<void>;

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly judgments: ObjectiveJudgmentStore;
  readonly scheduler: EvaluationScheduler;
  readonly runner: EvaluatorRunner;
  readonly traces: UnitTraceCorpusReader;
  readonly externalSemanticResults: ExternalSemanticResultStore;
  private postCommitHook?: JudgmentCommittedHook;

  constructor(
    private readonly redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: {
      replayEvaluator?: ReplayEvaluator;
      semanticEvaluator?: SemanticEvaluator;
      traceStore?: UnitTraceCorpusReader;
    } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.judgments = new ObjectiveJudgmentStore(redis, async (value) => this.normalizeStoredJudgment(value));
    this.externalSemanticResults = new ExternalSemanticResultStore(redis);
    this.traces = options.traceStore ?? new InjectionTraceStore(redis);
    this.scheduler = new EvaluationScheduler({ annotations, snapshots: this.snapshots, traces: this.traces });
    this.runner = new EvaluatorRunner({
      ...(options.replayEvaluator ? { replay: options.replayEvaluator } : {}),
      ...(options.semanticEvaluator ? { semantic: options.semanticEvaluator } : {}),
    });
  }

  /**
   * Register a post-commit hook (F257 conclusion→governance→candidate). Fired
   * after every SUCCESSFUL Unit-run commit with a JudgmentCommittedEvent built
   * from the committed ObjectiveJudgment. Modeled EXACTLY on
   * GuardRejectionEventLog.setPostAppendHook: the emit site awaits the hook (so
   * the append chain resolves after the worker runs) but swallows throws
   * (fail-open) so a governance-worker failure never breaks the eval commit.
   */
  setPostCommitHook(hook: JudgmentCommittedHook): void {
    this.postCommitHook = hook;
  }

  /**
   * Cold-start repair for pre-v2 durable judgments. Reading normalizes the
   * stored row from its immutable snapshot, then re-emits it through the
   * idempotent governance worker. No operator re-trigger is required.
   */
  async reconcileLatestJudgments(ownerUserId: string): Promise<void> {
    for (const objective of this.catalog.registry.objectives) {
      const judgment = await this.judgments.latest(ownerUserId, objective.id);
      if (judgment) await this.emitJudgmentCommitted(judgment);
    }
  }

  private async normalizeStoredJudgment(value: unknown): Promise<ObjectiveJudgment | null> {
    if (!isRecord(value)) return null;
    const core = value as Partial<ObjectiveJudgment>;
    if (
      typeof core.judgmentId !== 'string' ||
      typeof core.snapshotId !== 'string' ||
      typeof core.ownerUserId !== 'string' ||
      typeof core.objectiveId !== 'string' ||
      !Array.isArray(core.metricResults) ||
      !Array.isArray(core.metricOutcomes) ||
      !Array.isArray(core.unitRefs) ||
      typeof core.evaluatedAt !== 'number'
    ) {
      return null;
    }
    if (
      core.schemaVersion === 2 &&
      typeof core.verdict === 'string' &&
      SEGMENT_VERDICTS.includes(core.verdict as SegmentVerdict) &&
      isCurrentVerdictDecision(core.verdictDecision) &&
      core.verdict === verdictForMetricDecisions(core.verdictDecision.metricDecisions) &&
      core.evaluationModelVersion === core.verdictDecision.evaluationModelVersion
    ) {
      return core as ObjectiveJudgment;
    }

    const objective = this.catalog.registry.objectives.find((definition) => definition.id === core.objectiveId);
    const model = this.catalog.registry.evaluationModels.find(
      (definition) => definition.id === objective?.evaluationModelId,
    );
    const snapshot = await this.snapshots.get(core.snapshotId);
    if (!model || !snapshot) return null;
    const conclusion = produceObjectiveVerdictDecision(
      { ...snapshot, evaluationModelVersion: model.ruleVersion, metricDefinitions: model.metrics },
      core.metricResults,
      core.metricOutcomes,
    );
    return {
      ...(value as Omit<ObjectiveJudgment, 'schemaVersion' | 'verdict' | 'verdictDecision'>),
      schemaVersion: 2,
      verdict: conclusion.verdict,
      verdictDecision: conclusion.decision,
    };
  }

  private async emitJudgmentCommitted(judgment: ObjectiveJudgment): Promise<void> {
    if (!this.postCommitHook) return;
    const snapshot = await this.snapshots.get(judgment.snapshotId);
    const segmentTraceHashes: Record<string, string> = {};
    if (snapshot) {
      for (const segmentId of new Set(
        judgment.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId),
      )) {
        const states = snapshot.traceCorpus.flatMap((episode) =>
          episode.summary.segments
            .filter((segment) => segment.segmentId === segmentId)
            .map((segment) => ({
              status: segment.status,
              pipelineStatus: segment.pipelineStatus ?? null,
              contentHash: segment.contentHash,
              version: segment.version ?? null,
            })),
        );
        if (states.length > 0) {
          // Proof binds the distinct injection states, not traffic volume. A
          // larger treatment sample with the same fired content must NOT look
          // like an override change merely because the array is longer.
          const canonicalStates = [...new Set(states.map((state) => JSON.stringify(state)))].sort();
          segmentTraceHashes[segmentId] = `sha256:${digest(canonicalStates)}`;
        }
      }
    }
    const event: JudgmentCommittedEvent = {
      judgmentId: judgment.judgmentId,
      ownerUserId: judgment.ownerUserId,
      objectiveId: judgment.objectiveId,
      verdict: judgment.verdict,
      verdictDecision: judgment.verdictDecision,
      unitRefs: judgment.unitRefs,
      segmentTraceHashes,
      window: judgment.window,
      evaluatedAt: judgment.evaluatedAt,
    };
    try {
      await this.postCommitHook(event);
    } catch {
      /* fail-open: a governance-worker failure must not break the eval commit. */
    }
  }

  async append(annotation: TraceAnnotation): Promise<{
    outcome: 'created' | 'duplicate';
    annotationId: string;
    unitEvaluationReady?: boolean;
  }> {
    const appended = await this.indexer.append(annotation);
    // Use createdAt + 1 as the exclusive upper bound so the triggering annotation
    // itself is included in the half-open Unit window [start, now).
    const unitEvaluationReady = await this.scheduleObjective(
      annotation.episodeRef.ownerUserId,
      annotation.objectiveId,
      annotation.createdAt + 1,
    );
    return { ...appended, ...(unitEvaluationReady ? { unitEvaluationReady: true } : {}) };
  }

  async scheduleObjective(ownerUserId: string, objectiveId: string, now: number): Promise<boolean> {
    const objective = this.catalog.registry.objectives.find((definition) => definition.id === objectiveId);
    if (!objective) return false;
    const model = this.catalog.registry.evaluationModels.find(
      (definition) => definition.id === objective.evaluationModelId,
    );
    if (!model) return false;
    const pendingBefore = await this.snapshots.getPendingUnitRun(ownerUserId, objectiveId);
    await this.evaluateObjective(ownerUserId, objective.id, model, now);
    const pendingAfter = await this.snapshots.getPendingUnitRun(ownerUserId, objectiveId);
    return !pendingBefore && hasExternalSemanticMetric(pendingAfter?.snapshot.metricDefinitions);
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    let evaluated = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      const { cadenceMetrics } = classifyMetrics(model.metrics);
      if (cadenceMetrics.length === 0) continue;
      // The scheduler derives first-run cadence from the Unit's first eligible
      // raw trace; the sweep itself does not manufacture a due watermark.
      const didRun = await this.evaluateObjective(ownerUserId, objective.id, model, now, true);
      if (didRun) evaluated++;
    }
    return evaluated;
  }

  /** Re-evaluate all owner Units after a raw trace terminal becomes durable. */
  async scheduleTraceVolume(ownerUserId: string, now: number): Promise<number> {
    let scheduled = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      const pendingBefore = await this.snapshots.getPendingUnitRun(ownerUserId, objective.id);
      if (await this.evaluateObjective(ownerUserId, objective.id, model, now)) continue;
      const pendingAfter = await this.snapshots.getPendingUnitRun(ownerUserId, objective.id);
      if (!pendingBefore && hasExternalSemanticMetric(pendingAfter?.snapshot.metricDefinitions)) {
        scheduled++;
      }
    }
    return scheduled;
  }

  /**
   * Accept one semantic result produced by an authenticated asynchronous eval
   * job, then resume the exact pending Unit snapshot. The staged result is
   * immutable and is not visible in the canonical result index until every
   * required metric reaches a terminal outcome and the Unit commit succeeds.
   */
  async acceptExternalSemanticResult(result: MetricResult): Promise<{ unitCompleted: boolean }> {
    if (result.kind !== 'semantic' || result.value.kind !== 'semantic') {
      throw new Error(`external_semantic_result_kind_mismatch:${result.metricId}`);
    }
    const snapshot = await this.snapshots.get(result.snapshotId);
    if (!snapshot) throw new Error(`external_semantic_snapshot_not_found:${result.snapshotId}`);
    if (snapshot.ownerUserId !== result.ownerUserId || snapshot.objectiveId !== result.objectiveId) {
      throw new Error(`external_semantic_result_coordinate_mismatch:${result.snapshotId}:${result.metricId}`);
    }
    const metric = snapshot.metricDefinitions.find((candidate) => candidate.id === result.metricId);
    if (!metric || metric.kind !== 'semantic' || metric.evaluator.kind !== 'llm') {
      throw new Error(`external_semantic_metric_not_found:${result.snapshotId}:${result.metricId}`);
    }

    const pending = await this.snapshots.getPendingUnitRun(snapshot.ownerUserId, snapshot.objectiveId);
    if (!pending) {
      const completed = await this.snapshots.latestCompleted(snapshot.ownerUserId, snapshot.objectiveId);
      if (completed?.snapshotId === snapshot.snapshotId) {
        await this.externalSemanticResults.append(result);
        return { unitCompleted: true };
      }
      throw new Error(`external_semantic_unit_not_pending:${result.snapshotId}`);
    }
    if (pending.snapshotId !== snapshot.snapshotId) {
      throw new Error(`external_semantic_pending_snapshot_mismatch:${result.snapshotId}:${pending.snapshotId}`);
    }
    const model = this.catalog.registry.evaluationModels.find(
      (candidate) => candidate.id === snapshot.evaluationModelId,
    );
    if (!model || model.ruleVersion !== snapshot.evaluationModelVersion) {
      throw new Error(`external_semantic_model_version_mismatch:${result.snapshotId}`);
    }
    await this.externalSemanticResults.append(result);
    const unitCompleted = await this.evaluateObjective(
      snapshot.ownerUserId,
      snapshot.objectiveId,
      model,
      result.evaluatedAt,
    );
    return { unitCompleted };
  }

  private async evaluateObjective(
    ownerUserId: string,
    objectiveId: string,
    model: import('./EvaluationScheduler.js').EvaluationModelInput,
    now: number,
    force = false,
  ): Promise<boolean> {
    const unitRefs = unitRefsForObjective(this.catalog, objectiveId);
    const scheduled = await this.scheduler.schedule({
      ownerUserId,
      objectiveId,
      evaluationModel: model,
      unitRefs,
      now,
      force,
    });
    if (scheduled.status !== 'queued') return false;

    // Claim the Unit run before evaluating metrics. The claim freezes the
    // expected watermark and snapshotId, preventing concurrent workers from
    // committing overlapping windows and allowing retries to resume the same
    // immutable snapshot.
    const snapshot = scheduled.snapshot;
    const expectedWatermark = snapshot.windowStartScore;
    const claimed = await this.claimUnitRun(ownerUserId, objectiveId, snapshot.snapshotId, expectedWatermark, snapshot);
    if (!claimed) return false;

    const metricOutcomes: Array<{
      metricId: string;
      result?: MetricResult;
      status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
      reason?: string;
    }> = [];
    for (const metric of model.metrics) {
      metricOutcomes.push(await this.evaluateMetric(snapshot, metric, now));
    }

    if (metricOutcomes.some((outcome) => outcome.status === 'unavailable')) {
      // A required metric could not be evaluated due to a transient failure
      // (missing replay adapter, runtime error, etc.). Do not commit a partial
      // Unit run; the pending key is left in place so the next schedule attempt
      // resumes the same snapshotId.
      return false;
    }

    const results = metricOutcomes
      .map((outcome) => outcome.result)
      .filter((result): result is MetricResult => result !== undefined);
    const committed = await this.commitUnitRun(snapshot, results, metricOutcomes, now);
    return committed;
  }

  private async claimUnitRun(
    ownerUserId: string,
    objectiveId: string,
    snapshotId: string,
    expectedWatermark: number,
    snapshot: EvaluationSnapshot,
  ): Promise<boolean> {
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      return true;
    }
    const unitRun = JSON.stringify({ snapshotId, expectedWatermark, snapshot });
    const result = (await this.redis.eval(
      CLAIM_UNIT_RUN_LUA,
      2,
      pendingKey(ownerUserId, objectiveId),
      watermarkKey(ownerUserId, objectiveId),
      snapshotId,
      String(expectedWatermark),
      unitRun,
    )) as number;
    return result === 1;
  }

  private async evaluateMetric(
    snapshot: EvaluationSnapshot,
    metric: EvaluationCatalogMetric,
    now: number,
  ): Promise<{
    metricId: string;
    result?: MetricResult;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }> {
    if (metric.kind === 'semantic' && metric.evaluator.kind === 'llm') {
      const staged = await this.externalSemanticResults.get(snapshot.snapshotId, metric.id);
      if (staged) return { metricId: metric.id, result: staged, status: 'evaluated' };
    }
    if (!this.runner.canRun(metric)) {
      return { metricId: metric.id, status: 'unavailable', reason: 'evaluator_unavailable' };
    }
    try {
      const result = await this.runner.run(snapshot, metric, now);
      if (result) return { metricId: metric.id, result, status: 'evaluated' };
      return { metricId: metric.id, status: 'insufficient_evidence', reason: 'insufficient_evidence' };
    } catch (error) {
      return {
        metricId: metric.id,
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async commitUnitRun(
    snapshot: EvaluationSnapshot,
    results: MetricResult[],
    metricOutcomes: Array<{
      metricId: string;
      result?: MetricResult;
      status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
      reason?: string;
    }>,
    evaluatedAt: number,
  ): Promise<boolean> {
    const judgment = buildObjectiveJudgment(snapshot, results, metricOutcomes, evaluatedAt);

    // Atomic commit via a single Lua script. A preflight inside the script checks
    // key types before any writes: Redis does not roll back writes on a runtime
    // error, so we must abort before the first mutating command when a key has an
    // unexpected type. The pending key remains for resume if the failure is
    // transient; a type mismatch returns -1 and also leaves the pending key.
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      await this.commitWithoutPipeline(snapshot, results, judgment);
      await this.emitJudgmentCommitted(judgment);
      return true;
    }

    // Build KEYS so the Redis client applies keyPrefix to every durable key.
    // Result/judgment payload and index keys are dynamic, so they are passed as
    // KEYS instead of ARGV to stay consistent with prefixed indexes.
    const keys: string[] = [
      pendingKey(snapshot.ownerUserId, snapshot.objectiveId),
      watermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
      cadenceWatermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
      `harness-evaluation-consumed-annotation:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
      `harness-evaluation-completed-snapshot-index:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
      completedWindowEndKey(snapshot.ownerUserId, snapshot.objectiveId),
    ];
    const resultEntries: [string, string, string][] = [];
    for (const result of results) {
      keys.push(
        `harness-metric-result:${result.resultId}`,
        `harness-metric-result-index:${result.ownerUserId}:${result.objectiveId}:${result.metricId}`,
      );
      resultEntries.push([JSON.stringify(result), String(result.evaluatedAt), result.resultId]);
    }
    keys.push(
      `harness-objective-judgment:${judgment.judgmentId}`,
      `harness-objective-judgment-index:${judgment.ownerUserId}:${judgment.objectiveId}`,
    );
    const judgmentEntry: [string, string, string] = [
      JSON.stringify(judgment),
      String(judgment.evaluatedAt),
      judgment.judgmentId,
    ];

    try {
      const committed = (await this.redis.eval(
        COMMIT_UNIT_RUN_LUA,
        keys.length,
        ...keys,
        snapshot.snapshotId,
        String(snapshot.maxAnnotationScore),
        String(snapshot.windowStartScore),
        String(evaluatedAt),
        String(snapshot.window.end),
        JSON.stringify(resultEntries),
        JSON.stringify(judgmentEntry),
        JSON.stringify(snapshot.annotationIds),
      )) as number;
      // Emit ONLY when the commit actually succeeded (return 1) — never on a
      // no-op (0) or a preflight abort (-1).
      if (committed === 1) {
        await this.emitJudgmentCommitted(judgment);
      }
      return committed === 1;
    } catch {
      // Transient failures (connection, injected test fault) are retryable.
      return false;
    }
  }

  private async commitWithoutPipeline(
    snapshot: EvaluationSnapshot,
    results: MetricResult[],
    judgment: ObjectiveJudgment,
  ): Promise<void> {
    for (const result of results) {
      await this.results.append(result);
    }
    await this.judgments.append(judgment);
    await this.snapshots.markAnnotationsConsumed(snapshot);
    await this.snapshots.markCompleted(snapshot, judgment.evaluatedAt);
  }
}

function hasExternalSemanticMetric(metrics: readonly MetricDefinition[] | undefined): boolean {
  return metrics?.some((metric) => metric.kind === 'semantic' && metric.evaluator.kind === 'llm') ?? false;
}

function unitRefsForObjective(
  catalog: EvaluationCatalog,
  objectiveId: string,
): import('@cat-cafe/shared').EvaluationUnitRef[] {
  return catalog.manifest.units
    .filter((unit) => unit.objectives.some((attachment) => attachment.objectiveId === objectiveId))
    .flatMap((unit) =>
      unit.objectives
        .filter((attachment) => attachment.objectiveId === objectiveId)
        .map((attachment) => ({
          unitType: 'segment' as const,
          unitId: unit.unitId,
          ...(attachment.clauseId ? { clauseId: attachment.clauseId } : {}),
        })),
    );
}

/**
 * Evaluate one metric against its EXPLICIT verdict rule. Trigger thresholds are
 * deliberately absent from this function: they decide readiness, never truth.
 */
function decideMetric(
  metric: MetricDefinition,
  result: MetricResult | undefined,
  outcome: { status: 'evaluated' | 'insufficient_evidence' | 'unavailable'; reason?: string },
  attributedSegmentIds: string[],
): MetricVerdictDecision {
  const rule: MetricVerdictRule = metric.verdictRule ?? { kind: 'evidence-only' };
  if (outcome.status !== 'evaluated') {
    return {
      metricId: metric.id,
      rule,
      status: outcome.status,
      reason: outcome.reason ?? outcome.status,
      measurement: null,
      attributedSegmentIds,
    };
  }
  if (!result) {
    return {
      metricId: metric.id,
      rule,
      status: 'inconclusive',
      reason: 'evaluated_without_result',
      measurement: null,
      attributedSegmentIds,
    };
  }

  return { ...decideMeasuredMetric(metric.id, rule, result.value), attributedSegmentIds };
}

type MetricDecisionCore = Omit<MetricVerdictDecision, 'attributedSegmentIds'>;

function decideMeasuredMetric(metricId: string, rule: MetricVerdictRule, value: MetricResultValue): MetricDecisionCore {
  switch (rule.kind) {
    case 'counter-zero':
      return decideCounter(metricId, rule, value);
    case 'rate-maximum':
    case 'rate-minimum':
      return value.kind === 'rate' ? decideRate(metricId, rule, value) : kindMismatch(metricId, rule);
    case 'semantic-label-maximum':
      return decideSemantic(metricId, rule, value);
    case 'replay-zero-failure':
      return decideReplay(metricId, rule, value);
    case 'evidence-only':
      return { metricId, rule, status: 'inconclusive', reason: 'metric_is_evidence_only', measurement: null };
  }
}

function decideCounter(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'counter-zero' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'counter') return kindMismatch(metricId, rule);
  return {
    metricId,
    rule,
    status: value.count > 0 ? 'breach' : 'clean',
    reason: `counter=${value.count}; zero required`,
    measurement: {
      kind: 'count',
      value: value.count,
      howCounted: `${metricId}:distinct-counterexamples(${value.count})`,
    },
  };
}

function decideRate(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'rate-maximum' | 'rate-minimum' }>,
  value: Extract<MetricResultValue, { kind: 'rate' }>,
): MetricDecisionCore {
  const maximum = rule.kind === 'rate-maximum';
  const breach = maximum ? value.rate > rule.maximum : value.rate < rule.minimum;
  return {
    metricId,
    rule,
    status: breach ? 'breach' : 'clean',
    reason: maximum ? `rate=${value.rate}; maximum=${rule.maximum}` : `rate=${value.rate}; minimum=${rule.minimum}`,
    measurement: {
      kind: 'rate-badness',
      value: maximum ? value.rate : 1 - value.rate,
      howCounted: maximum
        ? `${metricId}:${value.numerator}/${value.denominator}`
        : `${metricId}:1-(${value.numerator}/${value.denominator})`,
    },
  };
}

function decideSemantic(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'semantic-label-maximum' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'semantic') return kindMismatch(metricId, rule);
  const count = value.labels[rule.label] ?? 0;
  return {
    metricId,
    rule,
    status: count > rule.maximum ? 'breach' : 'clean',
    reason: `label(${rule.label})=${count}; maximum=${rule.maximum}`,
    measurement: {
      kind: 'count',
      value: count,
      howCounted: `${metricId}:label(${rule.label})=${count}`,
    },
  };
}

function decideReplay(
  metricId: string,
  rule: Extract<MetricVerdictRule, { kind: 'replay-zero-failure' }>,
  value: MetricResultValue,
): MetricDecisionCore {
  if (value.kind !== 'replay') return kindMismatch(metricId, rule);
  return {
    metricId,
    rule,
    status: value.failed > 0 ? 'breach' : 'clean',
    reason: `failed=${value.failed}; zero required`,
    measurement: {
      kind: 'count',
      value: value.failed,
      howCounted: `${metricId}:failed=${value.failed}; replayed=${value.passed + value.failed}`,
    },
  };
}

function kindMismatch(metricId: string, rule: MetricVerdictRule): MetricDecisionCore {
  return { metricId, rule, status: 'inconclusive', reason: 'result_rule_kind_mismatch', measurement: null };
}

export function produceObjectiveVerdictDecision(
  snapshot: Pick<EvaluationSnapshot, 'evaluationModelVersion' | 'metricDefinitions' | 'samples'>,
  results: MetricResult[],
  metricOutcomes: Array<{
    metricId: string;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>,
): { verdict: SegmentVerdict; decision: ObjectiveVerdictDecision } {
  const resultByMetric = new Map(results.map((result) => [result.metricId, result]));
  const outcomeByMetric = new Map(metricOutcomes.map((outcome) => [outcome.metricId, outcome]));
  const attributedSegmentsByMetric = collectMetricSegmentAttribution(snapshot.samples);
  const metricDecisions = snapshot.metricDefinitions.map((metric) =>
    decideMetric(
      metric,
      resultByMetric.get(metric.id),
      outcomeByMetric.get(metric.id) ?? { status: 'unavailable', reason: 'metric_outcome_missing' },
      attributedSegmentsByMetric.get(metric.id) ?? [],
    ),
  );
  const decisiveMeasurements = metricDecisions.filter(
    (metric): metric is MetricVerdictDecision & { measurement: NonNullable<MetricVerdictDecision['measurement']> } =>
      metric.measurement !== null,
  );
  const breachedMeasurements = decisiveMeasurements.filter((metric) => metric.status === 'breach');
  const attributedBreaches = breachedMeasurements.filter((metric) => metric.attributedSegmentIds.length > 0);
  // Measurements from different metrics can use different scales. Never rank a
  // count against a rate. Prefer an evidence-attributed breach, then choose one
  // deterministic metric and pin it for the whole PatchTrial.
  const primaryPool =
    attributedBreaches.length > 0
      ? attributedBreaches
      : breachedMeasurements.length > 0
        ? breachedMeasurements
        : decisiveMeasurements;
  const primary = [...primaryPool].sort((a, b) => a.metricId.localeCompare(b.metricId))[0];
  const verdict = verdictForMetricDecisions(metricDecisions);

  return {
    verdict,
    decision: {
      schemaVersion: 2,
      evaluationModelVersion: snapshot.evaluationModelVersion,
      metricDecisions,
      primaryMetricId: primary?.metricId ?? null,
      measurement: primary?.measurement ?? null,
      targetSegmentIds: primary?.attributedSegmentIds ?? [],
    },
  };
}

function verdictForMetricDecisions(metricDecisions: MetricVerdictDecision[]): SegmentVerdict {
  if (metricDecisions.some((metric) => metric.status === 'breach')) return 'retire-candidate';
  if (metricDecisions.some((metric) => metric.status === 'unavailable')) return 'observability-debt';
  if (metricDecisions.some((metric) => metric.status === 'insufficient_evidence')) return 'needs-denominator';
  if (metricDecisions.length > 0 && metricDecisions.every((metric) => metric.status === 'clean')) return 'alive';
  return 'unmeasurable';
}

function isCurrentVerdictDecision(value: unknown): value is ObjectiveVerdictDecision {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.evaluationModelVersion !== 'string' ||
    value.evaluationModelVersion.length === 0 ||
    !Array.isArray(value.metricDecisions) ||
    !value.metricDecisions.every(isMetricVerdictDecision) ||
    (typeof value.primaryMetricId !== 'string' && value.primaryMetricId !== null) ||
    !isMeasurementOrNull(value.measurement) ||
    !isStringArray(value.targetSegmentIds)
  ) {
    return false;
  }
  if (value.primaryMetricId === null) {
    return value.measurement === null && value.targetSegmentIds.length === 0;
  }
  const primary = value.metricDecisions.find((decision) => decision.metricId === value.primaryMetricId);
  return (
    primary !== undefined &&
    JSON.stringify(primary.measurement) === JSON.stringify(value.measurement) &&
    JSON.stringify(primary.attributedSegmentIds) === JSON.stringify(value.targetSegmentIds)
  );
}

function isMetricVerdictDecision(value: unknown): value is MetricVerdictDecision {
  return (
    isRecord(value) &&
    typeof value.metricId === 'string' &&
    value.metricId.length > 0 &&
    isMetricVerdictRule(value.rule) &&
    typeof value.status === 'string' &&
    METRIC_DECISION_STATUSES.has(value.status as MetricVerdictDecision['status']) &&
    typeof value.reason === 'string' &&
    isMeasurementOrNull(value.measurement) &&
    isStringArray(value.attributedSegmentIds)
  );
}

function isMetricVerdictRule(value: unknown): value is MetricVerdictRule {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'counter-zero' || value.kind === 'replay-zero-failure' || value.kind === 'evidence-only') {
    return Object.keys(value).length === 1;
  }
  if (value.kind === 'rate-maximum') return validUnitInterval(value.maximum);
  if (value.kind === 'rate-minimum') return validUnitInterval(value.minimum);
  return (
    value.kind === 'semantic-label-maximum' &&
    typeof value.label === 'string' &&
    value.label.length > 0 &&
    typeof value.maximum === 'number' &&
    Number.isSafeInteger(value.maximum) &&
    value.maximum >= 0
  );
}

function isMeasurementOrNull(value: unknown): value is MetricVerdictDecision['measurement'] {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'count' || value.kind === 'rate-badness') &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    (value.kind !== 'rate-badness' || value.value <= 1) &&
    typeof value.howCounted === 'string' &&
    value.howCounted.length > 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function validUnitInterval(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function collectMetricSegmentAttribution(samples: EvaluationSnapshot['samples']): Map<string, string[]> {
  const collected = new Map<string, Set<string>>();
  for (const sample of samples) {
    if (sample.polarity !== 'counterexample') continue;
    const segmentIds = sample.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId);
    if (segmentIds.length === 0) continue;
    const current = collected.get(sample.metricId) ?? new Set<string>();
    for (const segmentId of segmentIds) current.add(segmentId);
    collected.set(sample.metricId, current);
  }
  return new Map([...collected].map(([metricId, segmentIds]) => [metricId, [...segmentIds].sort()]));
}

function buildObjectiveJudgment(
  snapshot: EvaluationSnapshot,
  results: MetricResult[],
  metricOutcomes: Array<{
    metricId: string;
    result?: MetricResult;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>,
  evaluatedAt: number,
): ObjectiveJudgment {
  const unavailable = metricOutcomes.filter((outcome) => outcome.status === 'unavailable').length;
  let completion: ObjectiveJudgment['completion'];
  if (unavailable > 0) {
    // Unavailable metrics abort the commit before this point; keep the value
    // honest for any callers that build a judgment from an in-memory outcome set.
    completion = 'partial';
  } else if (
    metricOutcomes.length === 0 ||
    metricOutcomes.every((outcome) => outcome.status === 'insufficient_evidence')
  ) {
    completion = 'insufficient_evidence';
  } else {
    // A mix of evaluated and insufficient_evidence metrics is a complete Unit
    // evaluation: every required metric reached a terminal outcome.
    completion = 'complete';
  }

  const conclusion = produceObjectiveVerdictDecision(snapshot, results, metricOutcomes);
  return {
    schemaVersion: 2,
    judgmentId: `judgment-${digest(['objective', snapshot.snapshotId, snapshot.evaluationModelVersion])}`,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    evaluationModelId: snapshot.evaluationModelId,
    evaluationModelVersion: snapshot.evaluationModelVersion,
    unitRefs: snapshot.unitRefs,
    window: snapshot.window,
    metricResults: results,
    metricOutcomes: metricOutcomes.map((outcome) => ({
      metricId: outcome.metricId,
      status: outcome.status,
      reason: outcome.reason,
    })),
    annotationIds: snapshot.annotationIds,
    completion,
    verdict: conclusion.verdict,
    verdictDecision: conclusion.decision,
    evaluatedAt,
  };
}

// Local type alias to avoid importing non-shared EvaluationModelDefinition.
type EvaluationCatalogMetric = import('@cat-cafe/shared').MetricDefinition;
