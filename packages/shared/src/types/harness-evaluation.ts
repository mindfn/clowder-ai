import type { TraceEpisodeRef } from './injection-trace.js';

export type MetricKind = 'counter' | 'rate' | 'semantic' | 'replay';
export type TraceAnnotationSource = 'mcp-marker' | 'structured-rule' | 'semantic-sweep';
export type TraceAnnotationPolarity = 'counterexample' | 'positive' | 'candidate' | 'irrelevant' | 'unscorable';

export interface EvaluationUnitRef {
  unitType: 'segment';
  unitId: string;
  clauseId?: string;
}

export interface PendingTraceMarker {
  markerId: string;
  invocationId: string;
  ownerUserId: string;
  subjectCatId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
  polarity: Exclude<TraceAnnotationPolarity, 'irrelevant' | 'unscorable'> | 'candidate';
  note?: string;
  createdAt: number;
}

export interface TraceAnnotation {
  annotationId: string;
  episodeRef: TraceEpisodeRef;
  source: TraceAnnotationSource;
  ruleId: string;
  objectiveId: string;
  metricId: string;
  unitRefs: EvaluationUnitRef[];
  polarity: TraceAnnotationPolarity;
  confidence: number;
  incidentKey: string;
  evidenceRefs: string[];
  rationale?: string;
  createdAt: number;
  /**
   * F257 P1-3: per-objective monotonic ingest sequence assigned by the annotation
   * store. Combined with createdAt it forms a stable composite cursor that can
   * distinguish annotations sharing the same millisecond timestamp.
   */
  sequence?: number;
}

export type MetricTrigger =
  | { kind: 'distinct-counterexamples'; threshold: number; lookbackMs?: number }
  | { kind: 'minimum-sample'; minimum: number; windowMs: number }
  | { kind: 'cadence'; cadence: 'daily' | 'weekly' | `every-${number}d` };

export interface MetricDefinition {
  id: string;
  label: string;
  kind: MetricKind;
  evaluator: { kind: 'code' | 'llm' | 'replay'; ruleRef: string };
  trigger: MetricTrigger;
}

/**
 * F257: EvaluationSnapshot is a Unit-scoped frozen view.
 *
 * The Evaluation Unit is an Objective + its EvaluationModel + the segment unitRefs
 * attached to it. All metrics defined by the model are evaluated against the same
 * snapshot/window; the watermark belongs to the Unit run, not to any single metric.
 */
export interface EvaluationSnapshot {
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationUnitRef[];
  metricDefinitions: MetricDefinition[];
  window: { start: number; end: number };
  /**
   * F257 P1-2/P1-3: composite lower-bound cursor (timestamp + sequence) used to
   * resume the same immutable Unit run and to order same-ms annotations.
   */
  windowStartScore: number;
  /**
   * F257 P1-3: composite cursor of the newest consumed annotation in this run.
   * The Unit-run watermark is advanced to this score so late arrivals with the
   * same timestamp but a later sequence remain visible to the next run.
   */
  maxAnnotationScore: number;
  episodeRefs: TraceEpisodeRef[];
  annotationIds: string[];
  samples: Array<{
    annotationId: string;
    episodeRef: TraceEpisodeRef;
    objectiveId: string;
    metricId: string;
    unitRefs: EvaluationUnitRef[];
    incidentKey: string;
    polarity: TraceAnnotationPolarity;
    confidence: number;
    source: TraceAnnotationSource;
    rationale?: string;
    createdAt: number;
    sequence?: number;
  }>;
  createdAt: number;
}

export type MetricResultValue =
  | { kind: 'counter'; count: number; threshold: number }
  | { kind: 'rate'; numerator: number; denominator: number; rate: number }
  | { kind: 'semantic'; labels: Record<string, number>; explanation: string }
  | { kind: 'replay'; passed: number; failed: number };

export interface MetricResult {
  resultId: string;
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  metricId: string;
  kind: MetricKind;
  value: MetricResultValue;
  evaluatedAt: number;
}

export interface ObjectiveJudgment {
  judgmentId: string;
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  evaluationModelId: string;
  evaluationModelVersion: string;
  unitRefs: EvaluationUnitRef[];
  window: { start: number; end: number };
  metricResults: MetricResult[];
  metricOutcomes: Array<{
    metricId: string;
    status: 'evaluated' | 'insufficient_evidence' | 'unavailable';
    reason?: string;
  }>;
  annotationIds: string[];
  completion: 'complete' | 'partial' | 'insufficient_evidence';
  evaluatedAt: number;
}

export interface SegmentMetricEvaluationView {
  metricId: string;
  label: string;
  kind: MetricKind;
  evaluatorKind: 'code' | 'llm' | 'replay';
  trigger: MetricTrigger;
  collection: {
    window: { start: number; end: number };
    positive: number;
    counterexamples: number;
    candidates: number;
    classifiedTotal: number;
    pendingTowardTrigger: number;
    required: number | null;
  };
  latestEvaluation: {
    result: MetricResult;
    window: { start: number; end: number };
  } | null;
}

export interface SegmentObjectiveEvaluationView {
  objectiveId: string;
  objectiveLabel: string;
  evaluationModelId: string;
  evaluationModelLabel: string;
  ruleVersion: string;
  unitRefs: EvaluationUnitRef[];
  metrics: SegmentMetricEvaluationView[];
  /**
   * F257 P1-5: the latest ObjectiveJudgment for this Unit within the query window.
   * Null when no Unit run has completed for the objective in the window.
   */
  latestJudgment: {
    judgmentId: string;
    completion: ObjectiveJudgment['completion'];
    evaluatedAt: number;
    window: { start: number; end: number };
    /**
     * F257 P1-4: per-metric outcome vector from the judgment, so Console can
     * distinguish "the Unit run completed" from "a metric threshold was met".
     */
    metricOutcomes: ObjectiveJudgment['metricOutcomes'];
  } | null;
}

export interface SegmentEvaluationResponse {
  segmentId: string;
  window: { start: number; end: number };
  objectives: SegmentObjectiveEvaluationView[];
}
