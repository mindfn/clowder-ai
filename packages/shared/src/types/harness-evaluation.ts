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

export interface EvaluationSnapshot {
  snapshotId: string;
  ownerUserId: string;
  objectiveId: string;
  metricId: string;
  ruleVersion: string;
  window: { start: number; end: number };
  episodeRefs: TraceEpisodeRef[];
  annotationIds: string[];
  samples: Array<{
    annotationId: string;
    episodeRef: TraceEpisodeRef;
    incidentKey: string;
    polarity: TraceAnnotationPolarity;
    confidence: number;
    createdAt: number;
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
