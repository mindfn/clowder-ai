import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { EvaluationScheduler } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { type EvaluationCatalog, findMetricDefinition } from './evaluation-catalog.js';
import { EvaluatorRunner, type ReplayEvaluator } from './evaluator-runner.js';
import { MetricResultStore } from './MetricResultStore.js';

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly scheduler: EvaluationScheduler;
  readonly runner: EvaluatorRunner;

  constructor(
    redis: RedisClient,
    readonly catalog: EvaluationCatalog,
    readonly annotations: TraceAnnotationStore,
    options: { replayEvaluator?: ReplayEvaluator } = {},
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.scheduler = new EvaluationScheduler({ annotations, snapshots: this.snapshots });
    this.runner = new EvaluatorRunner({ ...(options.replayEvaluator ? { replay: options.replayEvaluator } : {}) });
  }

  async append(annotation: TraceAnnotation): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
    const appended = await this.indexer.append(annotation);
    await this.scheduleMetric(
      annotation.episodeRef.ownerUserId,
      annotation.objectiveId,
      annotation.metricId,
      Date.now(),
    );
    return appended;
  }

  async scheduleMetric(ownerUserId: string, objectiveId: string, metricId: string, now: number): Promise<void> {
    const definition = findMetricDefinition(this.catalog, objectiveId, metricId);
    if (!definition || definition.metric.trigger.kind === 'cadence') return;
    const scheduled = await this.scheduler.schedule({
      ownerUserId,
      objectiveId,
      metric: definition.metric,
      ruleVersion: definition.ruleVersion,
      now,
    });
    if (scheduled.status !== 'queued' || !this.runner.canRun(definition.metric)) return;
    await this.commitResult(scheduled.snapshot, await this.runner.run(scheduled.snapshot, definition.metric, now));
  }

  async runCadenceMetrics(ownerUserId: string, now: number): Promise<number> {
    let evaluated = 0;
    for (const objective of this.catalog.registry.objectives) {
      const model = this.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) continue;
      for (const metric of model.metrics) {
        if (metric.trigger.kind !== 'cadence' || !this.runner.canRun(metric)) continue;
        const scheduled = await this.scheduler.schedule({
          ownerUserId,
          objectiveId: objective.id,
          metric,
          ruleVersion: model.ruleVersion,
          now,
        });
        if (scheduled.status !== 'queued') continue;
        await this.commitResult(scheduled.snapshot, await this.runner.run(scheduled.snapshot, metric, now));
        evaluated++;
      }
    }
    return evaluated;
  }

  private async commitResult(
    snapshot: import('@cat-cafe/shared').EvaluationSnapshot,
    result: import('@cat-cafe/shared').MetricResult,
  ): Promise<void> {
    await this.results.append(result);
    await this.snapshots.markAnnotationsConsumed(snapshot);
    await this.snapshots.markCompleted(snapshot);
  }
}
