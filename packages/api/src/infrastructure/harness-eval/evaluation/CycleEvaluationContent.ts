import type { CycleEvaluationAssignment, CycleRecord, TraceAnnotation } from '@cat-cafe/shared';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';
import { isSkippedCycle } from './CycleRecordStore.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

export const MAX_CYCLE_ASSIGNMENT_BYTES = 32 * 1024;
export const MAX_ASSIGNMENT_COUNTEREXAMPLES = 64;

export async function buildCycleAssignment(
  deps: {
    catalog: EvaluationCatalog;
    annotations: Pick<TraceAnnotationStore, 'queryMetricWindow'>;
    history: CycleRecord[];
  },
  record: CycleRecord,
): Promise<CycleEvaluationAssignment> {
  const objective = deps.catalog.registry.objectives.find((item) => item.id === record.objectiveId);
  if (!objective) throw new Error(`cycle_objective_not_found:${record.objectiveId}`);
  const model = deps.catalog.registry.evaluationModels.find((item) => item.id === objective.evaluationModelId);
  if (!model) throw new Error(`cycle_evaluation_model_not_found:${objective.evaluationModelId}`);
  const priorSkipReasons = deps.history
    .slice(0, Math.max(0, record.windows.length - 1))
    .filter(isSkippedCycle)
    .reverse()
    .map((cycle) => ({ cycleId: cycle.cycleId, reason: skipReason(cycle) }));
  const counterexamples = await collectCounterexamples(
    deps.annotations,
    record,
    model.metrics.map((metric) => metric.id),
  );
  return fitAssignment(record, {
    objective: { id: objective.id, statement: objective.statement },
    version: record.version,
    versionContentRef: record.versionContentRef,
    windows: record.windows,
    ...(priorSkipReasons.length > 0 ? { priorSkipReasons } : {}),
    ...(record.approval?.state === 'rejected' && record.approval.reason
      ? { rejectReasons: [record.approval.reason] }
      : {}),
    metrics: model.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      evaluator: metric.evaluator.kind,
      ruleRef: metric.evaluator.ruleRef,
    })),
    counterexamples,
    readPoolTool: 'cat_cafe_read_cycle_traces(objectiveId, cycleId, cursor?)',
  });
}

export function formatCycleAssignment(record: CycleRecord, assignment: CycleEvaluationAssignment): string {
  return [
    '## F257 Cycle Evaluation Assignment',
    '',
    `Cycle: \`${record.cycleId}\``,
    'Read the immutable owner trace pool only through the named readPoolTool, starting with counterexample references.',
    'Submit every metric conclusion and the overall result with cat_cafe_submit_cycle_evaluation.',
    'Conversation text is not a writeback. Do not compare this cycle with another version.',
    '',
    '```json',
    JSON.stringify(assignment),
    '```',
  ].join('\n');
}

async function collectCounterexamples(
  annotations: Pick<TraceAnnotationStore, 'queryMetricWindow'>,
  record: CycleRecord,
  metricIds: string[],
): Promise<CycleEvaluationAssignment['counterexamples']> {
  const lists = await Promise.all(
    record.windows.flatMap((window) =>
      metricIds.map((metricId) =>
        annotations.queryMetricWindow(record.ownerUserId, record.objectiveId, metricId, window.start, window.end),
      ),
    ),
  );
  const unique = new Map<string, TraceAnnotation>();
  for (const annotation of lists.flat()) {
    if (annotation.polarity !== 'counterexample' || unique.has(annotation.incidentKey)) continue;
    unique.set(annotation.incidentKey, annotation);
  }
  return [...unique.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.incidentKey.localeCompare(right.incidentKey))
    .slice(0, MAX_ASSIGNMENT_COUNTEREXAMPLES)
    .map((annotation) => ({
      invocationId: annotation.episodeRef.invocationId,
      incidentKey: annotation.incidentKey,
      ...(annotation.rationale ? { rationale: truncate(annotation.rationale, 280) } : {}),
    }));
}

function fitAssignment(record: CycleRecord, assignment: CycleEvaluationAssignment): CycleEvaluationAssignment {
  const fitted = { ...assignment, counterexamples: [...assignment.counterexamples] };
  while (Buffer.byteLength(formatCycleAssignment(record, fitted)) > MAX_CYCLE_ASSIGNMENT_BYTES) {
    if (fitted.counterexamples.length === 0) throw new Error('cycle_assignment_base_exceeds_limit');
    fitted.counterexamples.pop();
  }
  return fitted;
}

function skipReason(record: CycleRecord): string {
  if (record.approval?.reason) return record.approval.reason;
  return record.evaluation?.overall === 'insufficient_evidence' ? 'insufficient_evidence' : 'operator_skip';
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
