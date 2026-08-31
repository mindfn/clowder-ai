/**
 * F257 GovernanceWorker — the conclusion→governance→candidate seam.
 *
 * Registered on `ObjectiveEvaluationRuntime.setPostCommitHook`, it receives a
 * `JudgmentCommittedEvent` after every SUCCESSFUL Unit-run commit and maps the
 * rolled-up verdict into a governance outcome:
 *   - `retire-candidate` → `intervention_candidate` → open ONE Candidate per
 *     target segment (frozen judgment-schema-v1 §3, originKind `eval-verdict`);
 *   - `alive` / `unmeasurable` / `needs-denominator` / `observability-debt`
 *     → `continue_observe` (no Candidate);
 *   - `dormant` → `no_change` (no Candidate).
 *
 * Only `retire-candidate` opens a Candidate — the worker never over-creates.
 *
 * Fail-open: the whole body is wrapped in try/catch. A governance-worker failure
 * must never break the eval commit that triggered it (the hook is also awaited
 * inside a swallowing try/catch on the runtime side).
 */

import { createHash } from 'node:crypto';
import type {
  Candidate,
  GovernanceOutcome,
  JudgmentCommittedEvent,
  PatchTrial,
  SegmentVerdict,
} from '@cat-cafe/shared';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import type { CandidateStore } from './CandidateStore.js';

export interface GovernanceWorkerDeps {
  candidateStore: CandidateStore;
  catalog: EvaluationCatalog;
  /** Production hook policy guard: never publish an override-disable card the executor must reject. */
  canDisableHook?: (hookId: string) => boolean;
  rollbackOverride?: (hookId: string, ownerUserId: string, reason: string) => Promise<void>;
  onCandidateCreated?: (candidate: Candidate, ownerUserId: string) => void;
  onError?: (error: unknown, event: JudgmentCommittedEvent) => void;
}

export function createGovernanceWorker(deps: GovernanceWorkerDeps): (event: JudgmentCommittedEvent) => Promise<void> {
  const governed = new Set(deps.catalog.manifest.units.map((unit) => unit.unitId));
  return async (event: JudgmentCommittedEvent): Promise<void> => {
    try {
      await processJudgment(event, governed, deps);
    } catch (error) {
      // Fail-open for the already-committed eval truth, but never fail-silent:
      // production supplies a structured logger so reconciliation gaps remain observable.
      try {
        deps.onError?.(error, event);
      } catch {
        /* logging must not break the eval commit either */
      }
    }
  };
}

async function processJudgment(
  event: JudgmentCommittedEvent,
  governed: Set<string>,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  // Objective results are projected to every member segment for visibility.
  // Existing trials still consume later clean windows, but NEW candidates may
  // open only for exact segment refs carried by the breached metric's evidence.
  const attributedSegments = new Set(event.verdictDecision.targetSegmentIds);
  const segmentIds = [
    ...new Set(event.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId)),
  ].filter((segmentId) => governed.has(segmentId));
  for (const segmentId of segmentIds) {
    // UnitEvaluationManifest.hookId is the lowercase asset/directory slug
    // (for example d11-skill-trigger). HookRegistry and HookOverrideStore are
    // keyed by the canonical segment/unit id (D11). Crossing those coordinate
    // systems silently makes every production policy check look unknown.
    await processSegment(event, segmentId, segmentId, attributedSegments.has(segmentId), deps);
  }
}

async function processSegment(
  event: JudgmentCommittedEvent,
  segmentId: string,
  hookId: string,
  mayOpenCandidate: boolean,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  if (await reconcilePatchTrials(deps.candidateStore, segmentId, hookId, event, deps)) return;
  if (!mayOpenCandidate) return;
  if (governanceOutcomeForVerdict(event.verdict) !== 'intervention_candidate') return;
  if (deps.canDisableHook && !deps.canDisableHook(hookId)) return;
  await openCandidate(event, segmentId, deps);
}

async function openCandidate(
  event: JudgmentCommittedEvent,
  segmentId: string,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  const baselineMeasurement = event.verdictDecision.measurement;
  const baselineMetricId = event.verdictDecision.primaryMetricId;
  const baselineTraceHash = event.segmentTraceHashes[segmentId];
  if (!baselineMeasurement || !baselineMetricId || !baselineTraceHash) return;
  const candidateId = `EC-${createHash('sha256')
    .update(`${event.judgmentId}:${segmentId}`)
    .digest('hex')
    .slice(0, 12)}`;
  const candidate: Candidate = {
    candidateId,
    type: 'retire-candidate',
    targetSegmentIds: [segmentId],
    originKind: 'eval-verdict',
    evidence: {
      anchors: [event.judgmentId],
      summary: `Eval verdict "${event.verdict}" for segment ${segmentId} (objective ${event.objectiveId}) — governance review requested.`,
    },
    proposedAction: {
      mechanism: 'override-disable',
      rollback: `Clear the ${segmentId} override to restore the manifest baseline.`,
    },
    status: 'proposed',
    approval: { approvedBy: null, decidedAt: null, note: null },
  };
  const outcome = await deps.candidateStore.createInterventionIfNone(
    candidate,
    {
      ownerUserId: event.ownerUserId,
      judgmentId: event.judgmentId,
      objectiveId: event.objectiveId,
      baselineEvaluationModelVersion: event.verdictDecision.evaluationModelVersion,
      createdAt: event.evaluatedAt,
      baselineTraceHash,
      baselineMetricId,
      baseline: {
        window: { startMs: event.window.start, endMs: event.window.end },
        measurement: {
          kind: baselineMeasurement.kind,
          value: baselineMeasurement.value,
          how_counted: baselineMeasurement.howCounted,
        },
      },
    },
    segmentId,
  );
  if (outcome === 'created') deps.onCandidateCreated?.(candidate, event.ownerUserId);
}

async function reconcilePatchTrials(
  candidateStore: CandidateStore,
  segmentId: string,
  hookId: string,
  event: JudgmentCommittedEvent,
  deps: GovernanceWorkerDeps,
): Promise<boolean> {
  let active = false;
  for (const candidate of await candidateStore.listBySegment(event.ownerUserId, segmentId)) {
    active = (await reconcileCandidateTrial(candidateStore, candidate, segmentId, hookId, event, deps)) || active;
  }
  return active;
}

async function reconcileCandidateTrial(
  candidateStore: CandidateStore,
  candidate: Candidate,
  segmentId: string,
  hookId: string,
  event: JudgmentCommittedEvent,
  deps: GovernanceWorkerDeps,
): Promise<boolean> {
  if (!['approved', 'executing', 'verifying'].includes(candidate.status)) return false;
  const trial = (await candidateStore.listPatchTrials(candidate.candidateId)).find(
    (current) => current.decision === 'pending',
  );
  if (!trial) return false;
  const context = await candidateStore.getEvaluationContext(candidate.candidateId);
  if (!context) throw new Error(`governance_candidate_context_unavailable:${candidate.candidateId}`);
  if (!isTreatmentWindowMature(trial, event)) {
    if (candidate.status !== 'verifying') {
      await candidateStore.updateCandidate(candidate, { ...candidate, status: 'verifying' });
    }
    return true;
  }
  const treatmentMeasurement = event.verdictDecision.metricDecisions.find(
    (decision) => decision.metricId === context.baselineMetricId,
  )?.measurement;
  const comparableMeasurement =
    event.verdictDecision.evaluationModelVersion === context.baselineEvaluationModelVersion &&
    treatmentMeasurement?.kind === trial.baseline.measurement.kind
      ? treatmentMeasurement
      : null;
  const treatmentTraceHash = event.segmentTraceHashes[segmentId];
  if (!comparableMeasurement || !treatmentTraceHash || treatmentTraceHash === trial.trace.beforeHash) {
    await persistInconclusiveTrial(candidateStore, candidate, trial, event, comparableMeasurement, treatmentTraceHash);
    return true;
  }
  await closeMeasuredTrial(
    candidateStore,
    candidate,
    trial,
    hookId,
    event,
    comparableMeasurement,
    treatmentTraceHash,
    deps,
  );
  return true;
}

function isTreatmentWindowMature(trial: PatchTrial, event: JudgmentCommittedEvent): boolean {
  const minWindowMs = trial.minWindowDays * 24 * 60 * 60 * 1000;
  return (
    event.window.start >= trial.treatment.window.startMs &&
    event.window.end - event.window.start >= minWindowMs &&
    event.window.end >= trial.treatment.window.endMs
  );
}

async function persistInconclusiveTrial(
  candidateStore: CandidateStore,
  candidate: Candidate,
  trial: PatchTrial,
  event: JudgmentCommittedEvent,
  treatmentMeasurement: { kind: 'count' | 'rate-badness'; value: number; howCounted: string } | null | undefined,
  treatmentTraceHash: string | undefined,
): Promise<void> {
  await candidateStore.completePatchTrial({
    currentCandidate: candidate,
    nextCandidate: { ...candidate, status: 'verifying' },
    currentTrial: trial,
    nextTrial: {
      ...trial,
      ...(treatmentMeasurement
        ? {
            treatment: {
              window: { startMs: event.window.start, endMs: event.window.end },
              measurement: {
                kind: treatmentMeasurement.kind,
                value: treatmentMeasurement.value,
                how_counted: treatmentMeasurement.howCounted,
              },
            },
          }
        : {}),
      outcome: 'inconclusive',
      decision: 'pending',
      trace: { ...trial.trace, afterHash: treatmentTraceHash ?? 'pending:treatment-trace' },
    },
  });
}

async function closeMeasuredTrial(
  candidateStore: CandidateStore,
  candidate: Candidate,
  trial: PatchTrial,
  hookId: string,
  event: JudgmentCommittedEvent,
  treatmentMeasurement: { kind: 'count' | 'rate-badness'; value: number; howCounted: string },
  treatmentTraceHash: string,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  const comparison = compareTrial(trial, treatmentMeasurement.value);
  if (comparison.decision === 'rollback') {
    if (!deps.rollbackOverride) throw new Error('governance_rollback_executor_unavailable');
    await deps.rollbackOverride(hookId, event.ownerUserId, `PatchTrial ${trial.trialId} regressed`);
  }
  await candidateStore.completePatchTrial({
    currentCandidate: candidate,
    nextCandidate: { ...candidate, status: comparison.decision === 'rollback' ? 'falsified' : 'closed' },
    currentTrial: trial,
    nextTrial: {
      ...trial,
      treatment: {
        window: { startMs: event.window.start, endMs: event.window.end },
        measurement: {
          kind: treatmentMeasurement.kind,
          value: treatmentMeasurement.value,
          how_counted: treatmentMeasurement.howCounted,
        },
      },
      outcome: comparison.outcome,
      decision: comparison.decision,
      trace: { ...trial.trace, afterHash: treatmentTraceHash },
    },
  });
}

function compareTrial(
  trial: PatchTrial,
  treatmentValue: number,
): { outcome: PatchTrial['outcome']; decision: PatchTrial['decision'] } {
  if (treatmentValue < trial.baseline.measurement.value) return { outcome: 'improved', decision: 'solidify' };
  if (treatmentValue > trial.baseline.measurement.value) return { outcome: 'regressed', decision: 'rollback' };
  return { outcome: 'no-change', decision: 'solidify' };
}

/** verdict → governance outcome (judgment-schema-v1 §3 governance ring). */
function governanceOutcomeForVerdict(verdict: SegmentVerdict): GovernanceOutcome {
  switch (verdict) {
    case 'retire-candidate':
      return 'intervention_candidate';
    case 'dormant':
      return 'no_change';
    default:
      // alive / unmeasurable / needs-denominator / observability-debt: keep observing.
      return 'continue_observe';
  }
}
