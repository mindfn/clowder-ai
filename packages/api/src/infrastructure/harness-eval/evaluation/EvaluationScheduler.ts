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
    const start = triggerWindowStart(input.metric, input.now);
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
    const candidates = selectCandidates(input.metric, annotations, consumed);
    const required = requiredSampleCount(input.metric);
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
      samples: selected.map((annotation) => ({
        annotationId: annotation.annotationId,
        episodeRef: annotation.episodeRef,
        incidentKey: annotation.incidentKey,
        polarity: annotation.polarity,
        confidence: annotation.confidence,
        createdAt: annotation.createdAt,
      })),
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

function triggerWindowStart(metric: MetricDefinition, now: number): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.lookbackMs ? now - metric.trigger.lookbackMs : 0;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return now - metric.trigger.windowMs;
  }
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

function requiredSampleCount(metric: MetricDefinition): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.threshold;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return metric.trigger.minimum;
  }
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

function selectCandidates(
  metric: MetricDefinition,
  annotations: TraceAnnotation[],
  consumed: Set<string>,
): TraceAnnotation[] {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return distinctCounterexamples(annotations, consumed);
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return distinctRateSamples(annotations, consumed);
  }
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
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

function distinctRateSamples(annotations: TraceAnnotation[], consumed: Set<string>): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter(
      (annotation) =>
        (annotation.polarity === 'positive' || annotation.polarity === 'counterexample') &&
        !consumed.has(annotation.annotationId),
    )
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

export function evaluateRateSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult {
  if (metric.kind !== 'rate' || metric.trigger.kind !== 'minimum-sample') {
    throw new Error(`rate_evaluator_metric_not_supported:${metric.id}`);
  }
  if (snapshot.metricId !== metric.id) throw new Error(`rate_evaluator_metric_mismatch:${snapshot.metricId}`);
  const denominator = snapshot.samples.filter(
    (sample) => sample.polarity === 'positive' || sample.polarity === 'counterexample',
  ).length;
  if (denominator < metric.trigger.minimum) {
    throw new Error(`rate_evaluator_insufficient_snapshot:${snapshot.snapshotId}`);
  }
  const numerator = snapshot.samples.filter((sample) => sample.polarity === 'positive').length;
  const resultId = `result-${digest(['rate', snapshot.snapshotId, snapshot.ruleVersion])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: snapshot.metricId,
    kind: 'rate',
    value: { kind: 'rate', numerator, denominator, rate: numerator / denominator },
    evaluatedAt,
  };
}
