import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, MetricDefinition, MetricResult, TraceAnnotation } from '@cat-cafe/shared';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import type { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type EvaluationScheduleResult =
  | { status: 'not-ready'; observed: number; required: number }
  | { status: 'queued'; snapshot: EvaluationSnapshot };

export class EvaluationScheduler {
  constructor(
    private readonly deps: {
      annotations: TraceAnnotationStore;
      snapshots: EvaluationSnapshotStore;
    },
  ) {}

  async schedule(input: {
    ownerUserId: string;
    objectiveId: string;
    metric: MetricDefinition;
    ruleVersion: string;
    now: number;
  }): Promise<EvaluationScheduleResult> {
    if (input.metric.kind !== 'counter' || input.metric.trigger.kind !== 'distinct-counterexamples') {
      throw new Error(`evaluation_scheduler_trigger_not_supported:${input.metric.id}`);
    }

    const start = input.metric.trigger.lookbackMs ? input.now - input.metric.trigger.lookbackMs : 0;
    const annotations = await this.deps.annotations.queryMetricWindow(
      input.ownerUserId,
      input.objectiveId,
      input.metric.id,
      start,
      input.now + 1,
    );
    const consumed = await this.deps.snapshots.consumedAnnotationIds(
      input.ownerUserId,
      input.objectiveId,
      input.metric.id,
    );
    const candidates = distinctCounterexamples(annotations, consumed);
    const required = input.metric.trigger.threshold;
    if (candidates.length < required) return { status: 'not-ready', observed: candidates.length, required };

    const selected = candidates.slice(0, required);
    const annotationIds = selected.map((annotation) => annotation.annotationId);
    const snapshotId = `snapshot-${digest([
      input.ownerUserId,
      input.objectiveId,
      input.metric.id,
      input.ruleVersion,
      annotationIds,
    ])}`;
    const snapshot: EvaluationSnapshot = {
      snapshotId,
      ownerUserId: input.ownerUserId,
      objectiveId: input.objectiveId,
      metricId: input.metric.id,
      ruleVersion: input.ruleVersion,
      window: {
        start: Math.min(...selected.map((annotation) => annotation.createdAt)),
        end: input.now,
      },
      episodeRefs: selected.map((annotation) => annotation.episodeRef),
      annotationIds,
      createdAt: input.now,
    };
    const appended = await this.deps.snapshots.append(snapshot);
    // Repair the consumed projection even when a previous scheduler crashed
    // immediately after persisting the immutable snapshot.
    await this.deps.snapshots.markAnnotationsConsumed(snapshot);
    if (appended.outcome === 'duplicate') return { status: 'not-ready', observed: 0, required };
    return { status: 'queued', snapshot };
  }
}

function distinctCounterexamples(annotations: TraceAnnotation[], consumed: Set<string>): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter((annotation) => annotation.polarity === 'counterexample' && !consumed.has(annotation.annotationId))
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}

export function evaluateCounterSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult {
  if (metric.kind !== 'counter' || metric.trigger.kind !== 'distinct-counterexamples') {
    throw new Error(`counter_evaluator_metric_not_supported:${metric.id}`);
  }
  if (snapshot.metricId !== metric.id) throw new Error(`counter_evaluator_metric_mismatch:${snapshot.metricId}`);
  const resultId = `result-${digest(['counter', snapshot.snapshotId, snapshot.ruleVersion])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: snapshot.metricId,
    kind: 'counter',
    value: {
      kind: 'counter',
      count: snapshot.annotationIds.length,
      threshold: metric.trigger.threshold,
    },
    evaluatedAt,
  };
}
