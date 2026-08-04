import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { EvaluationIndexer } from './EvaluationIndexer.js';
import { EvaluationScheduler, evaluateCounterSnapshot } from './EvaluationScheduler.js';
import { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';
import { type EvaluationCatalog, findMetricDefinition } from './evaluation-catalog.js';
import { MetricResultStore } from './MetricResultStore.js';

export class ObjectiveEvaluationRuntime {
  readonly indexer: EvaluationIndexer;
  readonly snapshots: EvaluationSnapshotStore;
  readonly results: MetricResultStore;
  readonly scheduler: EvaluationScheduler;

  constructor(
    redis: RedisClient,
    private readonly catalog: EvaluationCatalog,
    annotations: TraceAnnotationStore,
  ) {
    this.indexer = new EvaluationIndexer(catalog, annotations);
    this.snapshots = new EvaluationSnapshotStore(redis);
    this.results = new MetricResultStore(redis);
    this.scheduler = new EvaluationScheduler({ annotations, snapshots: this.snapshots });
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
    if (!definition || definition.metric.trigger.kind !== 'distinct-counterexamples') return;
    const scheduled = await this.scheduler.schedule({
      ownerUserId,
      objectiveId,
      metric: definition.metric,
      ruleVersion: definition.ruleVersion,
      now,
    });
    if (scheduled.status !== 'queued') return;
    if (definition.metric.kind !== 'counter' || definition.metric.evaluator.kind !== 'code') return;
    await this.results.append(evaluateCounterSnapshot(scheduled.snapshot, definition.metric, now));
  }
}
