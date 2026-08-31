/**
 * F257 Harness Governance Schema.
 *
 * Candidate retains the frozen judgment-schema-v1 §3 contract. PatchTrial uses
 * the current Objective Evaluation measurement contract: counters remain raw
 * counts instead of being coerced into the retired synthetic violation-rate
 * coordinate.
 *   - `Candidate` (§3): the operator-approvable object produced by T1/T3/eval. The
 *     eval path opens EC-* Candidates from a `retire-candidate` verdict.
 *   - `PatchTrial` (§4): the modify+verify experiment record opened on approval.
 *   - `JudgmentCommittedEvent`: the post-commit event the ObjectiveEvaluationRuntime
 *     emits after a successful Unit-run commit, carried to the governance worker.
 *
 * The verdict vocabulary is reused from `SegmentVerdict` (segment-lifecycle
 * §2), never redefined here.
 */

import type { EvaluationUnitRef, ObjectiveVerdictDecision } from './harness-evaluation.js';
import type { SegmentVerdict } from './segment-lifecycle.js';

// ---------------------------------------------------------------------------
// §3 Candidate — the operator-approvable governance object
// ---------------------------------------------------------------------------

/** Candidate taxonomy (judgment-schema-v1 §3). Eval verdicts open `retire-candidate`. */
export type CandidateType =
  | 'redundant-duplicate'
  | 'redundant-cross-layer'
  | 'conflict-audience'
  | 'contradiction'
  | 'word-collision'
  | 'missing-segment'
  | 'retire-candidate';

/** Which producer opened the Candidate (judgment-schema-v1 §3). */
export type CandidateOriginKind = 't1-static' | 't3-gap' | 'eval-verdict' | 'live-incident';

/** Proposed remediation mechanism (judgment-schema-v1 §3, shared with §4 PatchTrial). */
export type CandidateMechanism =
  | 'override-disable'
  | 'override-content'
  | 'merge-segments'
  | 'add-guard'
  | 'rewrite'
  | 'intentional-keep'
  | 'none';

/** Candidate lifecycle status (judgment-schema-v1 §3). */
export type CandidateStatus = 'proposed' | 'approved' | 'rejected' | 'executing' | 'verifying' | 'closed' | 'falsified';

/** Evidence anchors + human summary backing the Candidate (§3 `evidence`). */
export interface CandidateEvidence {
  /** thread msg id / file anchor / judgmentId. */
  anchors: string[];
  summary: string;
}

/** The proposed remediation action (§3 `proposedAction`). */
export interface CandidateProposedAction {
  mechanism: CandidateMechanism;
  /** One-line rollback path (override kinds are naturally "clear the override"). */
  rollback: string;
}

/**
 * Operator gate (§3 `approval`) — the second ring. `approvedBy` is the operator id;
 * a cat must NEVER fill it (provenance iron law).
 */
export interface CandidateApproval {
  approvedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

/** Candidate — T1/T3/eval-produced awaiting-decision object (judgment-schema-v1 §3). */
export interface Candidate {
  /** T1 numbering (T1-C, T1-F) is reused; eval output uses the EC- namespace. */
  candidateId: string;
  type: CandidateType;
  /** `missing-segment` may carry an empty array; eval verdicts target the graded segment. */
  targetSegmentIds: string[];
  originKind: CandidateOriginKind;
  evidence: CandidateEvidence;
  proposedAction: CandidateProposedAction;
  status: CandidateStatus;
  approval: CandidateApproval;
}

// ---------------------------------------------------------------------------
// §4 PatchTrial — the modify + verify experiment record
// ---------------------------------------------------------------------------

/** Behavioral-diff outcome of a PatchTrial (judgment-schema-v1 §4). */
export type PatchTrialOutcome = 'improved' | 'no-change' | 'regressed' | 'inconclusive' | 'pending';

/** Operator/eval decision on a PatchTrial (judgment-schema-v1 §4). */
export type PatchTrialDecision = 'solidify' | 'rollback' | 'falsified' | 'pending';

/** One comparable metric measurement; counters deliberately remain counts. */
export interface PatchTrialMeasurement {
  kind: 'count' | 'rate-badness';
  value: number;
  how_counted: string;
}

/** One arm (baseline/treatment) of the behavioral diff (§4). */
export interface PatchTrialArm {
  window: { startMs: number; endMs: number };
  measurement: PatchTrialMeasurement;
}

/** PatchTrial — modify+verify ring experiment record (judgment-schema-v1 §4). */
export interface PatchTrial {
  schemaVersion: 2;
  /** pt-{candidateId}-{seq}. */
  trialId: string;
  candidateRef: string;
  mechanism: CandidateMechanism;
  /** e.g. `HookOverrideStore.disable(d21, source=operator-approved)`. */
  executedVia: string;
  baseline: PatchTrialArm;
  treatment: PatchTrialArm;
  /** v1 default 5; a diff window shorter than this may not emit an outcome. */
  minWindowDays: number;
  outcome: PatchTrialOutcome;
  decision: PatchTrialDecision;
  /** Injection trace proof that the segment truly changed/disappeared. */
  trace: { beforeHash: string; afterHash: string };
}

// ---------------------------------------------------------------------------
// Governance worker seam — post-commit event + verdict→outcome mapping
// ---------------------------------------------------------------------------

/**
 * How a committed eval verdict maps into governance:
 *   - `intervention_candidate` → open a Candidate (only `retire-candidate` does this);
 *   - `continue_observe` → keep observing (no Candidate);
 *   - `no_change` → conclusive-but-inert (no Candidate).
 */
export type GovernanceOutcome = 'continue_observe' | 'no_change' | 'intervention_candidate';

/**
 * Emitted by ObjectiveEvaluationRuntime after a SUCCESSFUL Unit-run commit and
 * carried to the governance worker (the conclusion→governance seam). Built from
 * the committed ObjectiveJudgment in scope.
 */
export interface JudgmentCommittedEvent {
  judgmentId: string;
  ownerUserId: string;
  objectiveId: string;
  verdict: SegmentVerdict;
  verdictDecision: ObjectiveVerdictDecision;
  unitRefs: EvaluationUnitRef[];
  /**
   * Cryptographic digest of each target segment's injection states in the
   * immutable evaluation corpus. PatchTrial uses the baseline/treatment pair
   * to prove the approved override actually changed or removed the segment.
   */
  segmentTraceHashes: Record<string, string>;
  window: { start: number; end: number };
  evaluatedAt: number;
}
