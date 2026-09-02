import type {
  CycleRecord,
  MetricDefinition,
  SegmentCycleSummary,
  SegmentEvaluationResponse,
  SegmentObjectiveEvaluationView,
  TraceAnnotation,
} from '@cat-cafe/shared';

import type { EvaluationModelDefinition, ObjectiveDefinition } from '../objective-registry.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';
import { unitRefsForObjective } from './segment-evaluation-helpers.js';

type ObjectiveProjection = {
  objective: SegmentObjectiveEvaluationView;
  trigger: SegmentEvaluationResponse['tracing']['trigger']['perObjective'][number];
  counterexamples: TraceAnnotation[];
};

/** F257 S4: Console projection whose only cycle truth is CycleRecord. */
export class SegmentEvaluationReadModel {
  constructor(
    private readonly runtime: ObjectiveEvaluationRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async read(input: {
    ownerUserId: string;
    segmentId: string;
    startMs: number;
    endMs: number;
  }): Promise<SegmentEvaluationResponse> {
    const unit = this.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === input.segmentId);
    if (!unit) throw new Error(`segment_evaluation_unit_not_found:${input.segmentId}`);

    const projections = await Promise.all(
      unit.objectives.map(async (attachment) => {
        const objective = this.requireObjective(attachment.objectiveId);
        const model = this.requireModel(objective.evaluationModelId);
        return this.projectObjective(input, objective, model);
      }),
    );
    const counterexamples = distinctIncidents(projections.flatMap((projection) => projection.counterexamples)).filter(
      (annotation) =>
        annotation.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === input.segmentId),
    );

    return {
      segmentId: input.segmentId,
      window: { start: input.startMs, end: input.endMs },
      tracing: {
        trigger: { perObjective: projections.map((projection) => projection.trigger) },
        structuredCounterexamples: counterexamples.map((annotation) => ({
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
      objectives: projections.map((projection) => projection.objective),
    };
  }

  private async projectObjective(
    input: { ownerUserId: string; startMs: number; endMs: number },
    objective: ObjectiveDefinition,
    model: EvaluationModelDefinition,
  ): Promise<ObjectiveProjection> {
    const [current, history] = await Promise.all([
      this.runtime.cycles.current(input.ownerUserId, objective.id),
      this.runtime.cycles.history(input.ownerUserId, objective.id, 8),
    ]);
    const cycleStart = current?.cycleStart ?? input.startMs;
    // An open Objective cycle is live independently of whichever segment
    // version/query window the operator selected in the lifeline.
    const cycleEnd = current?.cycleEnd ?? this.now();
    const [cumulativeCount, annotationLists] = await Promise.all([
      this.runtime.objectiveTraces.countWindow(input.ownerUserId, objective.id, cycleStart, cycleEnd),
      Promise.all(
        model.metrics.map((metric) =>
          this.runtime.annotations.queryMetricWindow(input.ownerUserId, objective.id, metric.id, cycleStart, cycleEnd),
        ),
      ),
    ]);
    const counterexamples = distinctIncidents(
      annotationLists.flat().filter((annotation) => annotation.polarity === 'counterexample'),
    );
    const records = [...(current ? [current] : []), ...history];
    const latestEvaluated = records.find((record) => record.evaluation);
    const latestGoverned = records.find((record) => record.governance);
    const latestMetrics = new Map(
      (latestEvaluated?.evaluation?.metrics ?? []).map((metric) => [metric.id, metric] as const),
    );
    const versionChain = [...history].reverse().map(toSummary);
    if (current) versionChain.push(toSummary(current));

    return {
      trigger: {
        objectiveId: objective.id,
        evalStatus: current?.evalStatus ?? 'idle',
        cycleStartMs: cycleStart,
        cycleEndMs: current?.cycleEnd ?? null,
        triggeredBy: current?.triggeredBy ?? [],
        cumulative: { count: cumulativeCount, threshold: model.cycleTrigger.cumulativeThreshold },
        counterexamples: { count: counterexamples.length, threshold: model.cycleTrigger.counterexampleThreshold },
        cadence: {
          elapsedMs: Math.max(0, cycleEnd - cycleStart),
          thresholdMs: model.cycleTrigger.cadenceDays * 24 * 60 * 60 * 1000,
          eligible: cumulativeCount > 0,
        },
      },
      counterexamples,
      objective: {
        objectiveId: objective.id,
        objectiveLabel: objective.label,
        objectiveStatement: objective.statement,
        evaluationModelId: model.id,
        evaluationModelLabel: model.label,
        ruleVersion: model.ruleVersion,
        unitRefs: unitRefsForObjective(this.runtime, objective.id),
        metrics: model.metrics.map((metric) => metricView(metric, latestMetrics.get(metric.id))),
        currentCycle: current ? toSummary(current) : null,
        latestEvaluation: latestEvaluated?.evaluation
          ? {
              cycleId: latestEvaluated.cycleId,
              overall: latestEvaluated.evaluation.overall,
              writtenAt: latestEvaluated.evaluation.writtenAt,
              by: latestEvaluated.evaluation.by,
              windows: latestEvaluated.windows,
            }
          : null,
        latestGovernance: latestGoverned?.governance
          ? {
              cycleId: latestGoverned.cycleId,
              ...latestGoverned.governance,
              approval: latestGoverned.approval ?? null,
            }
          : null,
        versionChain,
      },
    };
  }

  private requireObjective(objectiveId: string): ObjectiveDefinition {
    const objective = this.runtime.catalog.registry.objectives.find((candidate) => candidate.id === objectiveId);
    if (!objective) throw new Error(`segment_evaluation_objective_not_found:${objectiveId}`);
    return objective;
  }

  private requireModel(modelId: string): EvaluationModelDefinition {
    const model = this.runtime.catalog.registry.evaluationModels.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`segment_evaluation_model_not_found:${modelId}`);
    return model;
  }
}

function metricView(
  metric: MetricDefinition,
  latest: NonNullable<CycleRecord['evaluation']>['metrics'][number] | undefined,
): SegmentObjectiveEvaluationView['metrics'][number] {
  return {
    metricId: metric.id,
    label: metric.label,
    kind: metric.kind,
    evaluatorKind: metric.evaluator.kind,
    evaluatorRuleRef: metric.evaluator.ruleRef,
    verdictRule: metric.verdictRule,
    latestConclusion: latest?.conclusion ?? null,
    evidenceRefs: latest?.evidenceRefs ?? [],
  };
}

function toSummary(record: CycleRecord): SegmentCycleSummary {
  return {
    cycleId: record.cycleId,
    version: record.version,
    versionContentRef: record.versionContentRef,
    cycleStart: record.cycleStart,
    cycleEnd: record.cycleEnd ?? null,
    evalStatus: record.evalStatus,
    windows: record.windows,
    triggeredBy: record.triggeredBy ?? [],
    evaluation: record.evaluation
      ? {
          overall: record.evaluation.overall,
          writtenAt: record.evaluation.writtenAt,
          by: record.evaluation.by,
        }
      : null,
    governance: record.governance ?? null,
    approval: record.approval ?? null,
    rejectReasons: record.rejectReasons ?? [],
    closedAt: record.closedAt ?? null,
  };
}

function distinctIncidents(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const seen = new Set<string>();
  return [...annotations]
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      if (seen.has(annotation.incidentKey)) return false;
      seen.add(annotation.incidentKey);
      return true;
    });
}
