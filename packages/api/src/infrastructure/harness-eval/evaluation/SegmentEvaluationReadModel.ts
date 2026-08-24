import type {
  EvaluationSnapshot,
  EvaluationUnitRef,
  MetricDefinition,
  SegmentEvaluationResponse,
  SegmentMetricEvaluationView,
  SegmentObjectiveEvaluationView,
  SegmentTracingEvaluationView,
  TraceAnnotation,
} from '@cat-cafe/shared';
import { EVALUATION_READINESS_WINDOW_MS, EVALUATION_TRACE_VOLUME_THRESHOLD } from '@cat-cafe/shared';

import { metricWindowStartFor, selectCandidates } from './EvaluationScheduler.js';
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
    const tracingMetrics: Array<{ objectiveId: string; metric: MetricDefinition }> = [];
    for (const attachment of unit.objectives) {
      const objective = this.runtime.catalog.registry.objectives.find(
        (candidate) => candidate.id === attachment.objectiveId,
      );
      if (!objective) throw new Error(`segment_evaluation_objective_not_found:${attachment.objectiveId}`);
      const model = this.runtime.catalog.registry.evaluationModels.find(
        (candidate) => candidate.id === objective.evaluationModelId,
      );
      if (!model) throw new Error(`segment_evaluation_model_not_found:${objective.evaluationModelId}`);
      tracingMetrics.push(...model.metrics.map((metric) => ({ objectiveId: objective.id, metric })));
      const [metrics, latestJudgment] = await Promise.all([
        Promise.all(
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
        ),
        this.latestJudgment(input.ownerUserId, objective.id, input.startMs, input.endMs),
      ]);
      objectiveViews.push({
        objectiveId: objective.id,
        objectiveLabel: objective.label,
        evaluationModelId: model.id,
        evaluationModelLabel: model.label,
        ruleVersion: model.ruleVersion,
        unitRefs: unitRefsForObjective(this.runtime, objective.id),
        metrics,
        latestJudgment,
      });
    }
    const annotationLists = await Promise.all(
      tracingMetrics.map(({ objectiveId, metric }) =>
        this.runtime.annotations.queryMetricWindow(
          input.ownerUserId,
          objectiveId,
          metric.id,
          input.startMs,
          input.endMs,
        ),
      ),
    );
    const unitRefs = distinctUnitRefs(objectiveViews.flatMap((objective) => objective.unitRefs));
    const objectiveIds = unit.objectives.map((attachment) => attachment.objectiveId);
    const trigger = await this.buildTracingTrigger(input, objectiveIds, tracingMetrics, annotationLists, unitRefs);
    const structuredCounterexamples = distinctIncidents(
      annotationLists
        .flat()
        .filter(
          (annotation) =>
            annotation.polarity === 'counterexample' &&
            annotation.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === input.segmentId),
        ),
    );
    return {
      segmentId: input.segmentId,
      window: { start: input.startMs, end: input.endMs },
      tracing: {
        trigger,
        structuredCounterexamples: structuredCounterexamples.map((annotation) => ({
          annotationId: annotation.annotationId,
          incidentKey: annotation.incidentKey,
          objectiveId: annotation.objectiveId,
          metricId: annotation.metricId,
          source: annotation.source,
          createdAt: annotation.createdAt,
          ...(annotation.rationale ? { rationale: annotation.rationale } : {}),
          threadId: annotation.episodeRef.threadId,
          turnId: annotation.episodeRef.traceTurnId,
          catId: annotation.episodeRef.catId,
        })),
      },
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
    // F257 P1-4: Console must use the same per-metric window/candidate semantics
    // as the scheduler, not a single caller-supplied window. Annotation scores are
    // plain createdAt millis; result scores remain plain millis.
    const metricWindowStartMs = Math.max(input.startMs, metricWindowStartFor(input.metric, input.endMs));
    const annotationStartScore = metricWindowStartMs;
    const annotationEndScore = input.endMs;

    const [objectiveAnnotations, consumed, results] = await Promise.all([
      this.runtime.annotations.queryMetricWindow(
        input.ownerUserId,
        input.objectiveId,
        input.metric.id,
        annotationStartScore,
        annotationEndScore,
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
    const segmentAnnotations = objectiveAnnotations.filter((annotation) =>
      annotation.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === input.segmentId),
    );
    const unconsumedSegmentAnnotations = segmentAnnotations.filter(
      (annotation) => !consumed.has(annotation.annotationId),
    );
    const candidates = selectCandidates(input.metric, unconsumedSegmentAnnotations);
    const { result: latestResult, snapshot: latestSnapshot } = await this.latestSegmentResult(
      results
        .filter((result) => result.metricId === input.metric.id)
        .sort((left, right) => right.evaluatedAt - left.evaluatedAt || right.resultId.localeCompare(left.resultId)),
      input.segmentId,
    );
    return {
      metricId: input.metric.id,
      label: input.metric.label,
      kind: input.metric.kind,
      evaluatorKind: input.metric.evaluator.kind,
      evaluatorRuleRef: input.metric.evaluator.ruleRef,
      trigger: input.metric.trigger,
      collection: {
        window: { start: metricWindowStartMs, end: input.endMs },
        positive: candidates.filter((annotation) => annotation.polarity === 'positive').length,
        counterexamples: candidates.filter((annotation) => annotation.polarity === 'counterexample').length,
        candidates: candidates.filter((annotation) => annotation.polarity === 'candidate').length,
        classifiedTotal: candidates.filter(
          (annotation) => annotation.polarity === 'positive' || annotation.polarity === 'counterexample',
        ).length,
        pendingTowardTrigger: candidates.length,
        required: triggerRequirement(input.metric),
      },
      latestEvaluation: latestResult && latestSnapshot ? { result: latestResult, window: latestSnapshot.window } : null,
    };
  }

  private async latestSegmentResult(
    results: Awaited<ReturnType<ObjectiveEvaluationRuntime['results']['queryMetricWindow']>>,
    segmentId: string,
  ): Promise<{
    result: Awaited<ReturnType<ObjectiveEvaluationRuntime['results']['get']>>;
    snapshot: EvaluationSnapshot | null;
  }> {
    for (const result of results) {
      const snapshot = await this.runtime.snapshots.get(result.snapshotId);
      if (!snapshot) continue;
      // A Unit result belongs to every member segment. Raw-only semantic runs
      // legitimately have no annotations or metric sample buckets.
      const isUnitMember = snapshot.unitRefs.some(
        (unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === segmentId,
      );
      if (isUnitMember) {
        return { result, snapshot };
      }
    }
    return { result: null, snapshot: null };
  }

  private async latestJudgment(
    ownerUserId: string,
    objectiveId: string,
    startMs: number,
    endMs: number,
  ): Promise<SegmentObjectiveEvaluationView['latestJudgment']> {
    const judgment = await this.runtime.judgments.latest(ownerUserId, objectiveId);
    if (!judgment || judgment.evaluatedAt < startMs || judgment.evaluatedAt >= endMs) return null;
    return {
      judgmentId: judgment.judgmentId,
      completion: judgment.completion,
      evaluatedAt: judgment.evaluatedAt,
      window: judgment.window,
      metricOutcomes: judgment.metricOutcomes,
    };
  }

  /**
   * Per-Objective readiness projection: each Objective has its own completedWindowEnd
   * watermark, trace count, and counterexample count. Top-level summary fields use
   * MAX trace count and MAX/MIN counterexample count/threshold across Objectives
   * (never union count, which inflates O1=2 + O2=2 into 4).
   */
  private async buildTracingTrigger(
    input: { ownerUserId: string; segmentId: string; startMs: number; endMs: number },
    objectiveIds: string[],
    tracingMetrics: Array<{ objectiveId: string; metric: MetricDefinition }>,
    annotationLists: TraceAnnotation[][],
    unitRefs: EvaluationUnitRef[],
  ): Promise<SegmentTracingEvaluationView['trigger']> {
    const completedEnds = await Promise.all(
      objectiveIds.map((id) => this.runtime.snapshots.completedWindowEnd(input.ownerUserId, id)),
    );
    const fallbackStart = Math.max(input.startMs, input.endMs - EVALUATION_READINESS_WINDOW_MS);
    const perObjective: SegmentTracingEvaluationView['trigger']['perObjective'] = [];
    let maxTraceCount = 0;
    let bestWindowStart = fallbackStart;
    for (let i = 0; i < objectiveIds.length; i++) {
      const objectiveId = objectiveIds[i];
      const windowStart = completedEnds[i] > 0 ? completedEnds[i] : fallbackStart;
      const count = await this.runtime.traces.countSegmentWindow(
        input.ownerUserId,
        input.segmentId,
        windowStart,
        input.endMs,
      );
      const objCx = distinctIncidents(
        tracingMetrics
          .flatMap((tm, idx) => (tm.objectiveId === objectiveId ? annotationLists[idx] : []))
          .filter(
            (a) =>
              a.polarity === 'counterexample' &&
              a.unitRefs.some((au) => unitRefs.some((r) => r.unitType === au.unitType && r.unitId === au.unitId)),
          ),
      );
      const thresholds = tracingMetrics
        .filter((tm) => tm.objectiveId === objectiveId)
        .map(({ metric }) => (metric.trigger.kind === 'distinct-counterexamples' ? metric.trigger.threshold : null))
        .filter((v): v is number => v !== null);
      perObjective.push({
        objectiveId,
        traceCount: count,
        traceRequired: EVALUATION_TRACE_VOLUME_THRESHOLD,
        windowStartMs: windowStart,
        windowEndMs: input.endMs,
        counterexampleCount: thresholds.length > 0 ? objCx.length : null,
        counterexampleRequired: thresholds.length > 0 ? Math.min(...thresholds) : null,
      });
      if (count > maxTraceCount) {
        maxTraceCount = count;
        bestWindowStart = windowStart;
      }
    }
    if (objectiveIds.length === 0) {
      maxTraceCount = await this.runtime.traces.countSegmentWindow(
        input.ownerUserId,
        input.segmentId,
        fallbackStart,
        input.endMs,
      );
      bestWindowStart = fallbackStart;
    }
    const cxCounts = perObjective.map((po) => po.counterexampleCount).filter((v): v is number => v !== null);
    const cxReqs = perObjective.map((po) => po.counterexampleRequired).filter((v): v is number => v !== null);
    return {
      traceCount: maxTraceCount,
      traceRequired: EVALUATION_TRACE_VOLUME_THRESHOLD,
      windowMs: input.endMs - bestWindowStart,
      counterexampleCount: cxCounts.length > 0 ? Math.max(...cxCounts) : null,
      counterexampleRequired: cxReqs.length > 0 ? Math.min(...cxReqs) : null,
      perObjective,
    };
  }
}

function unitRefsForObjective(runtime: ObjectiveEvaluationRuntime, objectiveId: string): EvaluationUnitRef[] {
  return runtime.catalog.manifest.units.flatMap((unit) =>
    unit.objectives
      .filter((attachment) => attachment.objectiveId === objectiveId)
      .map((attachment) => ({
        unitType: 'segment' as const,
        unitId: unit.unitId,
        ...(attachment.clauseId ? { clauseId: attachment.clauseId } : {}),
      })),
  );
}

function distinctUnitRefs(unitRefs: EvaluationUnitRef[]): EvaluationUnitRef[] {
  const seen = new Set<string>();
  return unitRefs.filter((unitRef) => {
    const key = `${unitRef.unitType}:${unitRef.unitId}:${unitRef.clauseId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
