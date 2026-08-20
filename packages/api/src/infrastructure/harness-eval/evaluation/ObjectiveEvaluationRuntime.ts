import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricResult, ObjectiveJudgment, TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { EvaluationScheduler } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { type EvaluationCatalog } from './evaluation-catalog.js';
import { EvaluatorRunner, type ReplayEvaluator } from './evaluator-runner.js';
import { MetricResultStore } from './MetricResultStore.js';
import { ObjectiveJudgmentStore } from './ObjectiveJudgmentStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type RedisPipeline = ReturnType<RedisClient['multi']>;

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
    await this.scheduleObjective(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.createdAt);
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

    const metricOutcomes: Array<{
      metricId: string;
      result?: MetricResult;
      status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
      reason?: string;
    }> = [];
    for (const metric of model.metrics) {
      metricOutcomes.push(await this.evaluateMetric(scheduled.snapshot, metric, now));
    }

    if (metricOutcomes.some((outcome) => outcome.status === 'unavailable')) {
      // A required metric could not be evaluated due to a transient failure
      // (missing replay adapter, runtime error, etc.). Do not commit a partial
      // Unit run; leave the snapshot unconsumed so the next attempt can retry.
      return false;
    }

    const results = metricOutcomes
      .map((outcome) => outcome.result)
      .filter((result): result is MetricResult => result !== undefined);
    const committed = await this.commitUnitRun(scheduled.snapshot, results, metricOutcomes, now);
    return committed;
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

    // Atomic commit: results, judgment, consumed annotations, and the completed
    // watermark are written together. If any step fails, none of the durable
    // side effects are visible, and the next schedule attempt can retry against
    // the same immutable snapshotId.
    const pipeline =
      typeof (this.redis as { multi?: () => unknown }).multi === 'function'
        ? (this.redis as RedisClient & { multi: () => RedisPipeline }).multi()
        : undefined;
    if (!pipeline) {
      // Fallback for environments without transaction support (should not happen
      // in production with ioredis, but keeps tests honest if a stub omits multi).
      await this.commitWithoutPipeline(snapshot, results, judgment);
      return true;
    }

    for (const result of results) {
      const serialized = JSON.stringify(result);
      pipeline.set(`harness-metric-result:${result.resultId}`, serialized, 'NX');
      pipeline.zadd(
        `harness-metric-result-index:${result.ownerUserId}:${result.objectiveId}:${result.metricId}`,
        result.evaluatedAt,
        result.resultId,
      );
    }

    const serializedJudgment = JSON.stringify(judgment);
    pipeline.set(`harness-objective-judgment:${judgment.judgmentId}`, serializedJudgment, 'NX');
    pipeline.zadd(
      `harness-objective-judgment-index:${judgment.ownerUserId}:${judgment.objectiveId}`,
      judgment.evaluatedAt,
      judgment.judgmentId,
    );

    if (snapshot.annotationIds.length > 0) {
      pipeline.sadd(
        `harness-evaluation-consumed-annotation:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
        ...snapshot.annotationIds,
      );
    }
    pipeline.zadd(
      `harness-evaluation-completed-snapshot-index:${snapshot.ownerUserId}:${snapshot.objectiveId}`,
      snapshot.createdAt,
      snapshot.snapshotId,
    );

    try {
      const execResult = await pipeline.exec();
      if (!execResult) return false;
      const errors = execResult.filter((reply) => reply[0]).map((reply) => reply[0]);
      return errors.length === 0;
    } catch {
      // A transient pipeline failure (e.g., a connection error or injected test
      // fault) is retryable. The next schedule attempt will reuse the same
      // deterministic snapshotId and converge.
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
