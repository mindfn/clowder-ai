import type {
  CycleRecord,
  MetricDefinition,
  SegmentCycleSummary,
  SegmentEvaluationResponse,
  SegmentObjectiveEvaluationView,
  TraceAnnotation,
} from '@cat-cafe/shared';
import { isFiredTraceSegment } from '../../../domains/prompt-hooks/injection-trace-semantics.js';
import type { EvaluationModelDefinition, ObjectiveDefinition } from '../objective-registry.js';
import {
  counterexampleWakeKey,
  isEvaluationPriorityCounterexample,
} from '../trace-annotation/high-confidence-annotation.js';
import { cycleTriggerPolicyFor, initialCycleTriggerPolicy } from './cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';
import { unitRefsForObjective } from './segment-evaluation-helpers.js';

type ObjectiveProjection = {
  objective: SegmentObjectiveEvaluationView;
  trigger: SegmentEvaluationResponse['tracing']['trigger'];
  counterexamples: TraceAnnotation[];
  injections: SegmentEvaluationResponse['tracing']['injections'];
  injectionsCapped: boolean;
  window: { start: number; end: number };
};

const MAX_INJECTION_ROWS = 100;

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
    cycleId?: string;
  }): Promise<SegmentEvaluationResponse> {
    const unit = this.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === input.segmentId);
    if (!unit) throw new Error(`segment_evaluation_unit_not_found:${input.segmentId}`);

    const attachment = unit.objectives[0];
    if (!attachment) throw new Error(`segment_evaluation_objective_missing:${input.segmentId}`);
    const objective = this.requireObjective(attachment.objectiveId);
    const model = this.requireModel(objective.evaluationModelId);
    const projection = await this.projectObjective(input, objective, model);
    const projections = [projection];
    const counterexamples = distinctIncidents(projections.flatMap((projection) => projection.counterexamples)).filter(
      (annotation) =>
        annotation.unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === input.segmentId),
    );

    return {
      segmentId: input.segmentId,
      window: projection.window,
      tracing: {
        trigger: projection.trigger,
        injections: projection.injections,
        injectionsCapped: projection.injectionsCapped,
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
    input: { ownerUserId: string; segmentId: string; startMs: number; endMs: number; cycleId?: string },
    objective: ObjectiveDefinition,
    model: EvaluationModelDefinition,
  ): Promise<ObjectiveProjection> {
    const [current, history, requestedHistoryCycle, historyCount] = await Promise.all([
      this.runtime.cycles.current(input.ownerUserId, objective.id),
      this.runtime.cycles.history(input.ownerUserId, objective.id, 8),
      input.cycleId ? this.runtime.cycles.historyCycle(input.ownerUserId, objective.id, input.cycleId) : null,
      this.runtime.cycles.historyCount(input.ownerUserId, objective.id),
    ]);
    const selected = input.cycleId
      ? current?.cycleId === input.cycleId
        ? current
        : requestedHistoryCycle
      : (current ?? history[0] ?? null);
    if (input.cycleId && !selected) throw new Error(`segment_evaluation_cycle_not_found:${input.cycleId}`);

    const cycleStart = selected?.cycleStart ?? input.startMs;
    const cycleEnd = selected?.cycleEnd ?? this.now();
    const policy = selected ? cycleTriggerPolicyFor(this.runtime.catalog, selected) : initialCycleTriggerPolicy(model);
    const [cumulativeCount, segmentEpisodes, annotationLists] = await Promise.all([
      this.runtime.traces.countOwnerWindow(input.ownerUserId, cycleStart, cycleEnd),
      this.runtime.traces.queryUnitWindow(
        input.ownerUserId,
        [{ unitType: 'segment', unitId: input.segmentId }],
        cycleStart,
        cycleEnd,
      ),
      Promise.all(
        model.metrics.map((metric) =>
          this.runtime.annotations.queryMetricWindow(input.ownerUserId, objective.id, metric.id, cycleStart, cycleEnd),
        ),
      ),
    ]);
    const counterexamples = distinctWakeSignals(annotationLists.flat());
    const segmentRows = segmentEpisodes
      .map((episode) => episode.summary.segments.find((segment) => segment.segmentId === input.segmentId))
      .filter((segment): segment is NonNullable<typeof segment> => segment !== undefined);
    const injections = segmentEpisodes
      .flatMap((episode) => {
        const segment = episode.summary.segments.find((candidate) => candidate.segmentId === input.segmentId);
        if (!segment || !isFiredTraceSegment(segment)) return [];
        return [
          {
            threadId: episode.summary.threadId,
            turnId: episode.summary.turnId,
            timestamp: episode.summary.timestamp,
            catId: episode.summary.catId,
            pipelineStatus: 'fired' as const,
            version: segment.version ?? null,
            charCount: segment.charCount,
          },
        ];
      })
      .sort((left, right) => right.timestamp - left.timestamp || right.turnId.localeCompare(left.turnId));
    const selectedEvaluated = selected?.evaluation ? selected : undefined;
    const selectedGoverned = selected?.governance ? selected : undefined;
    const latestMetrics = new Map(
      (selectedEvaluated?.evaluation?.metrics ?? []).map((metric) => [metric.id, metric] as const),
    );
    const cycleTotal = historyCount + (current ? 1 : 0);
    const versionChain = [...history]
      .reverse()
      .map((record, index) => toSummary(record, historyCount - history.length + index + 1));
    if (current) versionChain.push(toSummary(current, cycleTotal));
    const selectedSummary = selected
      ? (versionChain.find((cycle) => cycle.cycleId === selected.cycleId) ?? toSummary(selected))
      : null;

    return {
      window: { start: cycleStart, end: cycleEnd },
      injections: injections.slice(0, MAX_INJECTION_ROWS),
      injectionsCapped: injections.length > MAX_INJECTION_ROWS,
      trigger: {
        objective: {
          objectiveId: objective.id,
          evalStatus: selected?.evalStatus ?? 'idle',
          lifecycle: objective.lifecycle === 'retired' ? 'retired' : (selected?.objectiveLifecycle ?? 'active'),
          health: cumulativeCount === 0 ? 'zero-trace-fault' : 'healthy',
          policyChangeCount: history.filter(
            (record) => record.cycleStart <= cycleStart && record.triggerPolicyChange !== undefined,
          ).length,
          cycleStartMs: cycleStart,
          cycleEndMs: selected?.cycleEnd ?? null,
          triggeredBy: selected?.triggeredBy ?? [],
          cumulative: { count: cumulativeCount, threshold: policy.cumulativeThreshold },
          counterexamples: { count: counterexamples.length, threshold: policy.counterexampleThreshold },
          cadence: {
            elapsedMs: Math.max(0, cycleEnd - cycleStart),
            thresholdMs: policy.cadenceDays * 24 * 60 * 60 * 1000,
            eligible: cumulativeCount > 0,
          },
        },
        segment: {
          segmentId: input.segmentId,
          observationCount: segmentRows.length,
          injectionCount: segmentRows.filter(isFiredTraceSegment).length,
          disabledCount: segmentRows.filter((segment) => segment.pipelineStatus === 'disabled').length,
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
        selectedCycle: selectedSummary,
        currentCycle: current ? toSummary(current, cycleTotal) : null,
        latestEvaluation: latestEvaluationView(selectedEvaluated),
        latestGovernance: latestGovernanceView(selectedGoverned),
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

function latestEvaluationView(record: CycleRecord | undefined): SegmentObjectiveEvaluationView['latestEvaluation'] {
  if (!record?.evaluation) return null;
  return {
    cycleId: record.cycleId,
    overall: record.evaluation.overall,
    writtenAt: record.evaluation.writtenAt,
    by: record.evaluation.by,
    windows: record.windows,
    ...(record.evaluation.coverageAssessment
      ? { coverageAssessment: structuredClone(record.evaluation.coverageAssessment) }
      : {}),
  };
}

function latestGovernanceView(record: CycleRecord | undefined): SegmentObjectiveEvaluationView['latestGovernance'] {
  if (!record?.governance) return null;
  return {
    cycleId: record.cycleId,
    ...record.governance,
    approval: record.approval ?? null,
  };
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

function toSummary(record: CycleRecord, ordinal?: number): SegmentCycleSummary {
  return {
    cycleId: record.cycleId,
    ...(ordinal !== undefined ? { ordinal } : {}),
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

function distinctWakeSignals(annotations: TraceAnnotation[]): TraceAnnotation[] {
  const seen = new Set<string>();
  return [...annotations]
    .filter(isEvaluationPriorityCounterexample)
    .sort((left, right) => left.createdAt - right.createdAt || left.annotationId.localeCompare(right.annotationId))
    .filter((annotation) => {
      const key = counterexampleWakeKey(annotation);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
