/**
 * F257 GovernanceWorker — the conclusion→governance→candidate seam.
 *
 * A retire-candidate verdict is input to the governance drafter. The drafter
 * may propose a content change, propose rolling back to an earlier version, or
 * skip. Only the first two actions open a Candidate for operator approval.
 * Applying an approved Candidate is the version transition; the next ordinary
 * evaluation window measures that version without a separate trial lifecycle.
 *
 * Fail-open: governance failures must never roll back committed evaluation
 * truth. Production supplies `onError`, so the failure is observable.
 */

import { createHash } from 'node:crypto';
import type { Candidate, GovernanceOutcome, JudgmentCommittedEvent, SegmentVerdict } from '@cat-cafe/shared';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import type { CandidateEvaluationContext, CandidateStore } from './CandidateStore.js';
import {
  assertValidGovernanceDecision,
  type GovernanceDecision,
  type GovernanceDecisionGenerator,
  SkipGovernanceDecisionGenerator,
} from './GovernanceDecisionGenerator.js';

export interface GovernanceWorkerDeps {
  candidateStore: CandidateStore;
  catalog: EvaluationCatalog;
  decisionGenerator?: GovernanceDecisionGenerator;
  resolveSegmentState?: (hookId: string) =>
    | Promise<{ currentContent: string; currentVersion: number } | null>
    | {
        currentContent: string;
        currentVersion: number;
      }
    | null;
  /** Production policy guard: never publish a card the executor must reject. */
  canEditHook?: (hookId: string) => boolean;
  onCandidateCreated?: (candidate: Candidate, ownerUserId: string) => void;
  onError?: (error: unknown, event: JudgmentCommittedEvent) => void;
}

export function createGovernanceWorker(deps: GovernanceWorkerDeps): (event: JudgmentCommittedEvent) => Promise<void> {
  const governed = new Set(deps.catalog.manifest.units.map((unit) => unit.unitId));
  const decisionGenerator = deps.decisionGenerator ?? new SkipGovernanceDecisionGenerator();
  return async (event: JudgmentCommittedEvent): Promise<void> => {
    try {
      await processJudgment(event, governed, decisionGenerator, deps);
    } catch (error) {
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
  decisionGenerator: GovernanceDecisionGenerator,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  if (governanceOutcomeForVerdict(event.verdict) !== 'intervention_candidate') return;
  const attributedSegments = new Set(event.verdictDecision.targetSegmentIds);
  const segmentIds = [
    ...new Set(event.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId)),
  ].filter((segmentId) => governed.has(segmentId) && attributedSegments.has(segmentId));
  for (const segmentId of segmentIds) {
    await processSegment(event, segmentId, segmentId, decisionGenerator, deps);
  }
}

async function processSegment(
  event: JudgmentCommittedEvent,
  segmentId: string,
  hookId: string,
  decisionGenerator: GovernanceDecisionGenerator,
  deps: GovernanceWorkerDeps,
): Promise<void> {
  const context = candidateContext(event, segmentId);
  if (!context) return;
  const candidateId = candidateIdFor(event.judgmentId, segmentId);
  const existing = await deps.candidateStore.get(candidateId);
  if (existing) {
    await deps.candidateStore.createInterventionIfNone(existing, context, segmentId);
    return;
  }
  if (deps.canEditHook && !deps.canEditHook(hookId)) return;
  const state = await deps.resolveSegmentState?.(hookId);
  if (!state) return;
  const decision = await decisionGenerator.decide({
    segmentId,
    objectiveId: event.objectiveId,
    currentContent: state.currentContent,
    currentVersion: state.currentVersion,
    verdict: event.verdict,
    verdictDecision: event.verdictDecision,
    conclusion: conclusionFor(event),
    counterexampleAnchors: event.counterexampleAnchors,
  });
  assertValidGovernanceDecision(decision);
  if (decision.action === 'skip') return;
  if (
    decision.action === 'change-content' &&
    decision.contentDraft?.proposedContent.trim() === state.currentContent.trim()
  ) {
    return;
  }
  if (decision.action === 'rollback' && decision.rollbackToVersion >= state.currentVersion) return;
  const candidate = candidateForDecision(candidateId, event, segmentId, state.currentVersion, decision);
  const outcome = await deps.candidateStore.createInterventionIfNone(candidate, context, segmentId);
  if (outcome === 'created') deps.onCandidateCreated?.(candidate, event.ownerUserId);
}

function candidateContext(event: JudgmentCommittedEvent, segmentId: string): CandidateEvaluationContext | null {
  const baselineMeasurement = event.verdictDecision.measurement;
  const baselineMetricId = event.verdictDecision.primaryMetricId;
  const baselineTraceHash = event.segmentTraceHashes[segmentId];
  if (!baselineMeasurement || !baselineMetricId || !baselineTraceHash) return null;
  return {
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
  };
}

function candidateForDecision(
  candidateId: string,
  event: JudgmentCommittedEvent,
  segmentId: string,
  sourceVersion: number,
  decision: GovernanceDecision,
): Candidate {
  if (decision.action === 'skip') throw new Error('governance_skip_cannot_open_candidate');
  const proposedAction =
    decision.action === 'change-content'
      ? {
          mechanism: 'override-content' as const,
          contentDraft: decision.contentDraft,
          sourceVersion,
          rollback: `Activate the prior ${segmentId} content version.`,
        }
      : {
          mechanism: 'override-content' as const,
          rollbackToVersion: decision.rollbackToVersion,
          sourceVersion,
          rollback: `Reactivate ${segmentId} v${decision.rollbackToVersion}.`,
        };
  return {
    candidateId,
    type: 'retire-candidate',
    targetSegmentIds: [segmentId],
    originKind: 'eval-verdict',
    evidence: {
      anchors: [event.judgmentId, ...event.counterexampleAnchors],
      summary: conclusionFor(event),
    },
    proposedAction,
    status: 'proposed',
    approval: { approvedBy: null, decidedAt: null, note: null },
  };
}

function candidateIdFor(judgmentId: string, segmentId: string): string {
  return `EC-${createHash('sha256').update(`${judgmentId}:${segmentId}`).digest('hex').slice(0, 12)}`;
}

function conclusionFor(event: JudgmentCommittedEvent): string {
  const metricSummary = event.verdictDecision.metricDecisions
    .map((decision) => {
      const reason = decision.reason ? ` (${decision.reason})` : '';
      return `${decision.metricId}:${decision.status}${reason}`;
    })
    .join('; ');
  return `Eval verdict "${event.verdict}" for objective ${event.objectiveId}: ${metricSummary || 'no metric detail'}`;
}

/** verdict → governance outcome (judgment-schema-v1 §3 governance ring). */
function governanceOutcomeForVerdict(verdict: SegmentVerdict): GovernanceOutcome {
  switch (verdict) {
    case 'retire-candidate':
      return 'intervention_candidate';
    case 'dormant':
      return 'no_change';
    default:
      return 'continue_observe';
  }
}
