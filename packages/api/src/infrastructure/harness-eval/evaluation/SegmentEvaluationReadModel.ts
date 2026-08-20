import type {
  EvaluationSnapshot,
  MetricDefinition,
  SegmentEvaluationResponse,
  SegmentMetricEvaluationView,
  TraceAnnotation,
} from '@cat-cafe/shared';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export class SegmentEvaluationReadModel {
  constructor(private readonly runtime: ObjectiveEvaluationRuntime) {}

  async read(input: {
    ownerUserId: string;
    segmentId: string;
    startMs: number;
    endMs: number;
  }): Promise<SegmentEvaluationResponse> {
    const unit = this.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === input.segmentId);
    if (!unit) throw new Error(`segment_evaluation_unit_not_found:${input.segmentId}`);

    const objectiveViews: SegmentEvaluationResponse['objectives'] = [];
    for (const attachment of unit.objectives) {
      const objective = this.runtime.catalog.registry.objectives.find(
        (candidate) => candidate.id === attachment.objectiveId,
      );
      if (!objective) throw new Error(`segment_evaluation_objective_not_found:${attachment.objectiveId}`);
      const model = this.runtime.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) throw new Error(`segment_evaluation_model_not_found:${objective.evaluationModelId}`);
      const metrics = await Promise.all(
        model.metrics.map((metric) =>
          this.readMetric({
            ownerUserId: input.ownerUserId,
            segmentId: input.segmentId,
            objectiveId: objective.id,
            metric,
            startMs: input.startMs,
            endMs: input.endMs,
          }),
        ),
      );
      objectiveViews.push({
        objectiveId: objective.id,
        objectiveLabel: objective.label,
        evaluationModelId: model.id,
        evaluationModelLabel: model.label,
        ruleVersion: model.ruleVersion,
        unitRefs: [
          {
            unitType: 'segment',
            unitId: input.segmentId,
            ...(attachment.clauseId ? { clauseId: attachment.clauseId } : {}),
          },
        ],
        metrics,
      });
    }
    return {
      segmentId: input.segmentId,
      window: { start: input.startMs, end: input.endMs },
      objectives: objectiveViews,
    };
  }

  private async readMetric(input: {
    ownerUserId: string;
    segmentId: string;
    objectiveId: string;
    metric: MetricDefinition;
    startMs: number;
    endMs: number;
  }): Promise<SegmentMetricEvaluationView> {
    const [objectiveAnnotations, consumed, results] = await Promise.all([
      this.runtime.annotations.queryMetricWindow(
        input.ownerUserId,
        input.objectiveId,
        input.metric.id,
        input.startMs,
        input.endMs,
      ),
      this.runtime.snapshots.consumedAnnotationIds(input.ownerUserId, input.objectiveId),
      this.runtime.results.queryMetricWindow(
        input.ownerUserId,
        input.objectiveId,
        input.metric.id,
        input.startMs,
        input.endMs,
      ),
    ]);
    const annotations = objectiveAnnotations.filter((annotation) =>
      annotation.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === input.segmentId),
    );
    const distinct = distinctIncidents(annotations);
    const pending = distinct.filter(
      (annotation) =>
        !consumed.has(annotation.annotationId) &&
        (annotation.polarity === 'positive' || annotation.polarity === 'counterexample'),
    );
    const { result: latestResult, snapshot: latestSnapshot } = await this.latestSegmentResult(
      results
        .filter((result) => result.metricId === input.metric.id)
        .sort((left, right) => right.evaluatedAt - left.evaluatedAt || right.resultId.localeCompare(left.resultId)),
      input.segmentId,
      input.metric.id,
    );
    return {
      metricId: input.metric.id,
      label: input.metric.label,
      kind: input.metric.kind,
      evaluatorKind: input.metric.evaluator.kind,
      trigger: input.metric.trigger,
      collection: {
        window: { start: input.startMs, end: input.endMs },
        positive: distinct.filter((annotation) => annotation.polarity === 'positive').length,
        counterexamples: distinct.filter((annotation) => annotation.polarity === 'counterexample').length,
        candidates: distinct.filter((annotation) => annotation.polarity === 'candidate').length,
        classifiedTotal: distinct.filter(
          (annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample',
        ).length,
        pendingTowardTrigger: pending.length,
        required: triggerRequirement(input.metric),
      },
      latestEvaluation: latestResult && latestSnapshot ? { result: latestResult, window: latestSnapshot.window } : null,
    };
  }

  private async latestSegmentResult(
    results: Awaited<ReturnType<ObjectiveEvaluationRuntime['results']['queryMetricWindow']>>,
    segmentId: string,
    metricId: string,
  ): Promise<{
    result: Awaited<ReturnType<ObjectiveEvaluationRuntime['results']['get']>>;
    snapshot: EvaluationSnapshot | null;
  }> {
    for (const result of results) {
      const snapshot = await this.runtime.snapshots.get(result.snapshotId);
      if (!snapshot || snapshot.annotationIds.length === 0) continue;
      // A result belongs to this (segment, metric) only if the frozen snapshot
      // contains at least one sample for the metric that is bound to the segment.
      const hasMatchingSample = snapshot.samples.some(
        (sample) =>
          sample.metricId === metricId &&
          sample.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === segmentId),
      );
      if (hasMatchingSample) {
        return { result, snapshot };
      }
    }
    return { result: null, snapshot: null };
  }
}

function distinctIncidents(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const seen = new Set<string>();
  return annotations
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (seen.has(annotation.incidentKey)) return false;
      seen.add(annotation.incidentKey);
      return true;
    });
}

function triggerRequirement(metric: MetricDefinition): number | null {
  if (metric.trigger.kind === 'distinct-counterexamples') return metric.trigger.threshold;
  if (metric.trigger.kind === 'minimum-sample') return metric.trigger.minimum;
  return null;
}
