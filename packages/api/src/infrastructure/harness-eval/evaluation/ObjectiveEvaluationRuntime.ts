import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricResult, ObjectiveJudgment, TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { classifyMetrics, EvaluationScheduler, isCadenceDue } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { EvaluatorRunner, type ReplayEvaluator } from './evaluator-runner.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const UNIT_RUN_PENDING_PREFIX = 'harness-unit-run-pending:';
const UNIT_RUN_WATERMARK_PREFIX = 'harness-unit-run-watermark:';

const pendingKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_PENDING_PREFIX}${ownerUserId}:${objectiveId}`;
const watermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_WATERMARK_PREFIX}${ownerUserId}:${objectiveId}`;

/**
 * F257 P1-1/P1-2: Atomic claim of a Unit run.
 *
 * A pending key freezes the expected watermark + snapshotId so concurrent
 * workers cannot commit overlapping windows, and retries can resume the same
 * immutable snapshot. If the watermark has advanced, any pending is stale and
 * is cleared.
 */
const CLAIM_UNIT_RUN_LUA = `
-- @fake-redis-handler: claimUnitRun
local pending = redis.call('GET', KEYS[1])
if pending ~= false and pending ~= ARGV[1] then
  return 0
end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

/**
 * F257 P1-1/P1-2: Atomic commit of a Unit run.
 *
 * All durable side effects (results, judgment, consumed annotations, completed
 * watermark) are written inside one Lua script. Redis executes the script
 * atomically; if any command fails the script returns an error and leaves no
 * partial writes. Precondition checks on the pending key and expected watermark
 * prevent lost-update races.
 */
const COMMIT_UNIT_RUN_LUA = `
-- @fake-redis-handler: commitUnitRun
local pending = redis.call('GET', KEYS[1])
if pending ~= ARGV[1] then return 0 end
local watermark = redis.call('GET', KEYS[2])
if watermark == false then watermark = '0' end
if watermark ~= ARGV[3] then
  redis.call('DEL', KEYS[1])
  return 0
end

local results = cjson.decode(ARGV[4])
for i = 1, #results, 5 do
  redis.call('SET', results[i], results[i+1], 'NX')
  redis.call('ZADD', results[i+2], results[i+3], results[i+4])
end

local judgment = cjson.decode(ARGV[5])
redis.call('SET', judgment[1], judgment[2], 'NX')
redis.call('ZADD', judgment[3], judgment[4], judgment[5])

local annotationIds = cjson.decode(ARGV[6])
if #annotationIds > 0 then
  redis.call('SADD', KEYS[3], unpack(annotationIds))
end

redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return 1
`;

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly judgments: ObjectiveJudgmentStore;
  readonly scheduler: EvaluationScheduler;
  readonly runner: EvaluatorRunner;

  constructor(
    private readonly redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: { replayEvaluator?: ReplayEvaluator } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.judgments = new ObjectiveJudgmentStore(redis);
    this.scheduler = new EvaluationScheduler({ annotations, snapshots: this.snapshots });
    this.runner = new EvaluatorRunner({ ...(options.replayEvaluator ? { replay: options.replayEvaluator } : {}) });
  }

  async append(annotation: TraceAnnotation): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
    const appended = await this.indexer.append(annotation);
    // Use createdAt + 1 as the exclusive upper bound so the triggering annotation
    // itself is included in the half-open Unit window [start, now).
    await this.scheduleObjective(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.createdAt + 1);
    return appended;
  }

  async scheduleObjective(ownerUserId: string, objectiveId: string, now: number): Promise<void> {
    const objective = this.catalog.registry.objectives.find((definition) => definition.id === objectiveId);
    if (!objective) return;
    const model = this.catalog.registry.evaluationModels.find(
      (definition) => definition.id === objective.evaluationModelId,
    );
    if (!model) return;
    await this.evaluateObjective(ownerUserId, objective.id, model, now);
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    let evaluated = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      // Only force Units that have a cadence metric whose watermark has elapsed.
      // The periodic sweep is not itself a cadence trigger; pure event-driven
      // Units must wait for their event threshold.
      const { cadenceMetrics } = classifyMetrics(model.metrics);
      if (cadenceMetrics.length === 0) continue;
      const completedWatermark = await this.snapshots.completedWatermark(ownerUserId, objective.id);
      const cadenceDue = isCadenceDue(cadenceMetrics, completedWatermark, now);
      if (cadenceDue.status !== 'due') continue;
      const didRun = await this.evaluateObjective(ownerUserId, objective.id, model, now, true);
      if (didRun) evaluated++;
    }
    return evaluated;
  }

  private async evaluateObjective(
    ownerUserId: string,
    objectiveId: string,
    model: import('./EvaluationScheduler.js').EvaluationModelInput,
    now: number,
    force = false,
  ): Promise<boolean> {
    if (!this.canRunUnit(model.metrics)) return false;

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
    const expectedWatermark = snapshot.window.start;
    const claimed = await this.claimUnitRun(ownerUserId, objectiveId, snapshot.snapshotId, expectedWatermark);
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
  ): Promise<boolean> {
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      return true;
    }
    const result = (await this.redis.eval(
      CLAIM_UNIT_RUN_LUA,
      2,
      pendingKey(ownerUserId, objectiveId),
      watermarkKey(ownerUserId, objectiveId),
      snapshotId,
      String(expectedWatermark),
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

  private canRunUnit(metrics: EvaluationCatalogMetric[]): boolean {
    return metrics.every((metric) => this.runner.canRun(metric));
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

    // Atomic commit via a single Lua script. Redis executes the script
    // atomically: precondition checks (pending key and expected watermark) run
    // first, then all writes happen together. A script error leaves no partial
    // durable state, and the pending key remains for resume if the failure is
    // transient.
    if (typeof (this.redis as { eval?: unknown }).eval !== 'function') {
      // Fallback for stubs without eval support (should not happen in production).
      await this.commitWithoutPipeline(snapshot, results, judgment);
      return true;
    }

    const resultArgs: string[] = [];
    for (const result of results) {
      resultArgs.push(
        `harness-metric-result:${result.resultId}`,
        JSON.stringify(result),
        `harness-metric-result-index:${result.ownerUserId}:${result.objectiveId}:${result.metricId}`,
        String(result.evaluatedAt),
        result.resultId,
      );
    }

    const judgmentArgs = [
      `harness-objective-judgment:${judgment.judgmentId}`,
      JSON.stringify(judgment),
      `harness-objective-judgment-index:${judgment.ownerUserId}:${judgment.objectiveId}`,
      String(judgment.evaluatedAt),
      judgment.judgmentId,
    ];

    try {
      const committed = (await this.redis.eval(
        COMMIT_UNIT_RUN_LUA,
        4,
        pendingKey(snapshot.ownerUserId, snapshot.objectiveId),
        watermarkKey(snapshot.ownerUserId, snapshot.objectiveId),
        `harness-evaluation-consumed-annotation:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
        `harness-evaluation-completed-snapshot-index:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
        snapshot.snapshotId,
        String(snapshot.window.end),
        String(snapshot.window.start),
        JSON.stringify(resultArgs),
        JSON.stringify(judgmentArgs),
        JSON.stringify(snapshot.annotationIds),
      )) as number;
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
    await this.snapshots.markCompleted(snapshot);
  }
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

  return {
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
    evaluatedAt,
  };
}

// Local type alias to avoid importing non-shared EvaluationModelDefinition.
type EvaluationCatalogMetric = import('@cat-cafe/shared').MetricDefinition;
