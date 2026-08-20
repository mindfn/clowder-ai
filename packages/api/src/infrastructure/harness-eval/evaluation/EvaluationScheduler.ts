import { createHash } from 'node:crypto';
import type {
  EvaluationSnapshot,
  EvaluationUnitRef,
  MetricDefinition,
  MetricResult,
  TraceAnnotation,
} from '@cat-cafe/shared';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import type { EvaluationSnapshotStore } from './EvaluationSnapshotStore.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type CadenceMetricDefinition = MetricDefinition & {
  trigger: { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };
};

export interface EvaluationModelInput {
  id: string;
  label: string;
  ruleVersion: string;
  metrics: MetricDefinition[];
}

export type EvaluationScheduleResult =
  | { status: 'not-ready'; observed: number; required: number }
  | { status: 'not-due'; nextDueAt: number }
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
    evaluationModel: EvaluationModelInput;
    unitRefs: EvaluationUnitRef[];
    now: number;
    /**
     * When true, the scheduler will evaluate a Unit even if its event-driven
     * metrics have not reached their sample threshold, emitting
     * `insufficient_evidence` outcomes instead of returning `not-ready`.
     * Used by the periodic `runCadenceMetrics` sweep.
     */
    force?: boolean;
  }): Promise<EvaluationScheduleResult> {
    const { metrics } = input.evaluationModel;
    const { cadenceMetrics, eventDrivenMetrics } = classifyMetrics(metrics);

    // Use the canonical Unit-run watermark as the exclusive start of the next
    // window. This is the single source of truth shared with the commit Lua
    // script, preventing lost-update races between concurrent workers.
    const windowStart = await this.deps.snapshots.completedWatermark(input.ownerUserId, input.objectiveId);

    // Cadence watermark is checked at the Unit level. A pure cadence Unit is not
    // due again until the previous completed Unit run's cadence has elapsed. A
    // mixed Unit also honors the cadence watermark, but an event-driven metric
    // can force an early run (Unit-level anyOf).
    const cadenceDue = isCadenceDue(cadenceMetrics, windowStart, input.now);

    const consumed = await this.deps.snapshots.consumedAnnotationIds(input.ownerUserId, input.objectiveId);
    const candidates = await this.collectCandidates(input, metrics, windowStart, consumed);
    const readiness = evaluateReadiness(
      metrics,
      eventDrivenMetrics,
      cadenceMetrics,
      cadenceDue,
      candidates,
      input.force ?? false,
    );
    if (readiness.status !== 'ready') return readiness.result;

    const snapshot = this.buildSnapshot(input, metrics, candidates, windowStart);
    const appended = await this.deps.snapshots.append(snapshot);
    // A duplicate immutable snapshot is still runnable. Consumption/completion
    // is committed only after MetricResult + ObjectiveJudgment append, so
    // evaluator failure stays retryable and concurrent workers converge through
    // deterministic snapshotId.
    if (appended.outcome === 'duplicate') return { status: 'queued', snapshot };
    return { status: 'queued', snapshot };
  }

  private async collectCandidates(
    input: {
      ownerUserId: string;
      objectiveId: string;
      now: number;
    },
    metrics: MetricDefinition[],
    windowStart: number,
    consumed: Set<string>,
  ): Promise<Map<string, TraceAnnotation[]>> {
    // The Unit snapshot freezes the cohort of annotations that arrived since the
    // last completed Unit run. Per-metric candidate selection preserves each
    // metric's own lookback/window contract, but they share the same Unit
    // watermark interval. Already-consumed annotations are excluded so the next
    // Unit does not reuse the previous window's upper-bound samples.
    //
    // Intervals are half-open [start, end): an annotation with createdAt == end
    // belongs to the *next* Unit run, guaranteeing monotonic watermarks and
    // avoiding zero-width windows when events share a millisecond.
    const annotationLists = await Promise.all(
      metrics.map((metric) => {
        const metricWindowStart = Math.max(windowStart, metricWindowStartFor(metric, input.now));
        return this.deps.annotations.queryMetricWindow(
          input.ownerUserId,
          input.objectiveId,
          metric.id,
          metricWindowStart,
          input.now,
        );
      }),
    );

    const metricCandidates = new Map<string, TraceAnnotation[]>();
    for (let index = 0; index < metrics.length; index++) {
      const unconsumed = annotationLists[index].filter((annotation) => !consumed.has(annotation.annotationId));
      metricCandidates.set(metrics[index].id, selectCandidates(metrics[index], unconsumed));
    }
    return metricCandidates;
  }

  private buildSnapshot(
    input: {
      ownerUserId: string;
      objectiveId: string;
      evaluationModel: EvaluationModelInput;
      unitRefs: EvaluationUnitRef[];
      now: number;
    },
    metrics: MetricDefinition[],
    candidates: Map<string, TraceAnnotation[]>,
    windowStart: number,
  ): EvaluationSnapshot {
    // The snapshot is the union of all metric candidate samples in the Unit
    // window. Readiness has already been checked; do not truncate the cohort
    // here, so every metric is evaluated against the same frozen window.
    const sampleSet = new Map<string, TraceAnnotation>();
    for (const metric of metrics) {
      for (const annotation of candidates.get(metric.id) ?? []) {
        sampleSet.set(annotation.annotationId, annotation);
      }
    }

    const selected = [...sampleSet.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId),
    );

    const annotationIds = selected.map((annotation) => annotation.annotationId);
    const episodeRefs = selected.map((annotation) => annotation.episodeRef);

    const snapshotId = `snapshot-${digest([
      input.ownerUserId,
      input.objectiveId,
      input.evaluationModel.id,
      input.evaluationModel.ruleVersion,
      input.unitRefs,
      annotationIds,
      windowStart,
      input.now,
    ])}`;

    return {
      snapshotId,
      ownerUserId: input.ownerUserId,
      objectiveId: input.objectiveId,
      evaluationModelId: input.evaluationModel.id,
      evaluationModelVersion: input.evaluationModel.ruleVersion,
      unitRefs: input.unitRefs,
      metricDefinitions: metrics,
      // Half-open Unit window: the upper bound is the exclusive cutoff for this
      // run and the inclusive start of the next run. This keeps watermarks
      // monotonic and prevents zero-width windows on same-ms events.
      window: { start: windowStart, end: input.now },
      episodeRefs,
      annotationIds,
      samples: selected.map((annotation) => ({
        annotationId: annotation.annotationId,
        episodeRef: annotation.episodeRef,
        objectiveId: annotation.objectiveId,
        metricId: annotation.metricId,
        unitRefs: annotation.unitRefs,
        incidentKey: annotation.incidentKey,
        polarity: annotation.polarity,
        confidence: annotation.confidence,
        source: annotation.source,
        ...(annotation.rationale ? { rationale: annotation.rationale } : {}),
        createdAt: annotation.createdAt,
      })),
      createdAt: input.now,
    };
  }
}

function metricWindowStartFor(metric: MetricDefinition, now: number): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.lookbackMs ? now - metric.trigger.lookbackMs : 0;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return now - metric.trigger.windowMs;
  }
  // Cadence/replay metrics have no rolling lookback; they use the Unit watermark.
  return 0;
}

export function classifyMetrics(metrics: MetricDefinition[]): {
  cadenceMetrics: CadenceMetricDefinition[];
  eventDrivenMetrics: MetricDefinition[];
} {
  const cadenceMetrics = metrics.filter(
    (metric): metric is CadenceMetricDefinition => metric.trigger.kind === 'cadence',
  );
  const eventDrivenMetrics = metrics.filter((metric) => metric.trigger.kind !== 'cadence');
  return { cadenceMetrics, eventDrivenMetrics };
}

export function isCadenceDue(
  cadenceMetrics: CadenceMetricDefinition[],
  completedWatermark: number,
  now: number,
): { status: 'due'; ready: boolean } | { status: 'not-due'; nextDueAt: number; ready: boolean } {
  if (cadenceMetrics.length === 0) return { status: 'due', ready: false };
  if (completedWatermark === 0) return { status: 'due', ready: true };
  const cadence = cadenceMetrics[0].trigger.cadence;
  const nextDueAt = completedWatermark + cadenceMs(cadence);
  if (now < nextDueAt) return { status: 'not-due', nextDueAt, ready: false };
  return { status: 'due', ready: true };
}

function evaluateReadiness(
  metrics: MetricDefinition[],
  eventDrivenMetrics: MetricDefinition[],
  cadenceMetrics: CadenceMetricDefinition[],
  cadenceDue: { status: 'due'; ready: boolean } | { status: 'not-due'; nextDueAt: number; ready: boolean },
  candidates: Map<string, TraceAnnotation[]>,
  force: boolean,
):
  | { status: 'ready'; metric: MetricDefinition }
  | { status: 'not-ready'; result: { status: 'not-ready'; observed: number; required: number } }
  | { status: 'not-due'; result: { status: 'not-due'; nextDueAt: number } } {
  // Unit-level anyOf: an event-driven metric can always force a run, even when
  // the Unit cadence watermark has not elapsed.
  const readyEventMetric = eventDrivenMetrics.find((metric) => {
    const list = candidates.get(metric.id) ?? [];
    return list.length >= requiredSampleCount(metric);
  });
  if (readyEventMetric) return { status: 'ready', metric: readyEventMetric };

  if (cadenceDue.status === 'not-due') {
    return { status: 'not-due', result: { status: 'not-due', nextDueAt: cadenceDue.nextDueAt } };
  }

  // Cadence watermark has elapsed. Run the Unit if a cadence metric has enough
  // samples. The evaluator will emit `insufficient_evidence` for metrics that do
  // not yet meet their sample requirements instead of throwing.
  if (cadenceMetrics.length > 0) {
    const readyCadenceMetric = cadenceMetrics.find((metric) => {
      const list = candidates.get(metric.id) ?? [];
      return list.length >= requiredSampleCount(metric);
    });
    if (readyCadenceMetric) return { status: 'ready', metric: readyCadenceMetric };
  }

  // Periodic sweep (force=true) may evaluate pending candidates for a Unit whose
  // cadence watermark has elapsed, even when no metric has reached its
  // event-driven threshold. It must not force pure event-driven Units: the
  // sweep itself is not a cadence trigger.
  if (force && cadenceMetrics.length > 0 && cadenceDue.status === 'due') {
    const anyCandidate = metrics.some((metric) => (candidates.get(metric.id) ?? []).length > 0);
    if (anyCandidate) return { status: 'ready', metric: metrics[0] };
  }

  // Return the most constrained event-driven metric for observability.
  const first = eventDrivenMetrics[0] ?? metrics[0];
  const list = candidates.get(first.id) ?? [];
  return {
    status: 'not-ready',
    result: { status: 'not-ready', observed: list.length, required: requiredSampleCount(first) },
  };
}

function requiredSampleCount(metric: MetricDefinition): number {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return metric.trigger.threshold;
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return metric.trigger.minimum;
  }
  if (metric.trigger.kind === 'cadence') return metric.kind === 'replay' ? 0 : 1;
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

function selectCandidates(metric: MetricDefinition, annotations: TraceAnnotation[]): TraceAnnotation[] {
  if (metric.kind === 'counter' && metric.trigger.kind === 'distinct-counterexamples') {
    return distinctCounterexamples(annotations);
  }
  if (metric.kind === 'rate' && metric.trigger.kind === 'minimum-sample') {
    return distinctRateSamples(annotations);
  }
  if (metric.trigger.kind === 'cadence') return distinctCadenceSamples(annotations);
  throw new Error(`evaluation_scheduler_trigger_not_supported:${metric.id}`);
}

function cadenceMs(cadence: 'daily' | 'weekly' | `every-${number}d`): number {
  if (cadence === 'daily') return 24 * 60 * 60 * 1000;
  if (cadence === 'weekly') return 7 * 24 * 60 * 60 * 1000;
  const match = /^every-(\d+)d$/.exec(cadence);
  if (!match || Number(match[1]) < 1) throw new Error(`evaluation_scheduler_invalid_cadence:${cadence}`);
  return Number(match[1]) * 24 * 60 * 60 * 1000;
}

function distinctCounterexamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter((annotation) => annotation.polarity === 'counterexample')
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}

function distinctRateSamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const incidents = new Set<string>();
  return annotations
    .filter((annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample')
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (incidents.has(annotation.incidentKey)) return false;
      incidents.add(annotation.incidentKey);
      return true;
    });
}

function distinctCadenceSamples(annotations: TraceAnnotation[]): TraceAnnotation[] {
  return distinctRateSamples(annotations);
}

export function evaluateCounterSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult {
  if (metric.kind !== 'counter' || metric.trigger.kind !== 'distinct-counterexamples') {
    throw new Error(`counter_evaluator_metric_not_supported:${metric.id}`);
  }
  const samples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
  const resultId = `result-${digest(['counter', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: metric.id,
    kind: 'counter',
    value: {
      kind: 'counter',
      count: samples.length,
      threshold: metric.trigger.threshold,
    },
    evaluatedAt,
  };
}

export function evaluateRateSnapshot(
  snapshot: EvaluationSnapshot,
  metric: MetricDefinition,
  evaluatedAt: number,
): MetricResult | null {
  if (metric.kind !== 'rate' || metric.trigger.kind !== 'minimum-sample') {
    throw new Error(`rate_evaluator_metric_not_supported:${metric.id}`);
  }
  const samples = snapshot.samples.filter((sample) => sample.metricId === metric.id);
  const denominator = samples.filter(
    (sample) => sample.polarity === 'positive' || sample.polarity === 'counterexample',
  ).length;
  if (denominator < metric.trigger.minimum) {
    return null;
  }
  const numerator = samples.filter((sample) => sample.polarity === 'positive').length;
  const resultId = `result-${digest(['rate', snapshot.snapshotId, snapshot.evaluationModelVersion, metric.id])}`;
  return {
    resultId,
    snapshotId: snapshot.snapshotId,
    ownerUserId: snapshot.ownerUserId,
    objectiveId: snapshot.objectiveId,
    metricId: metric.id,
    kind: 'rate',
    value: { kind: 'rate', numerator, denominator, rate: numerator / denominator },
    evaluatedAt,
  };
}
