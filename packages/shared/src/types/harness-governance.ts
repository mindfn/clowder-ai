/**
 * F257 Harness Governance Schema.
 *
 * Candidate retains the frozen judgment-schema-v1 §3 envelope while its
 * proposed action carries the current content-version governance contract.
 *   - `Candidate` (§3): the operator-approvable object produced by T1/T3/eval. The
 *     eval path opens EC-* Candidates from a `retire-candidate` verdict.
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

/** Proposed remediation mechanism (judgment-schema-v1 §3). */
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

/**
 * F257 content→v2 governance action (operator-confirmed model, 2026-09-01).
 * Each governance round the LLM drafts ONE of three decisions from THIS round's
 * metrics + conclusion; the operator approves/rejects it. No PatchTrial/固化 ring —
 * the next round's normal eval is the verification.
 *   - `change-content` → propose a new segment content version (v+1) via override.
 *   - `rollback`       → revert to a prior version.
 *   - `skip`           → keep the current version, accumulate more evidence.
 */
export type GovernanceDecisionAction = 'change-content' | 'rollback' | 'skip';

/** The proposed remediation action (§3 `proposedAction`). */
export interface CandidateProposedAction {
  mechanism: CandidateMechanism;
  /** One-line rollback path (override kinds are naturally "clear the override"). */
  rollback: string;
  /**
   * content→v2 (2026-09-01): for `override-content`, the LLM-drafted proposed new
   * segment content the operator approves BEFORE it is written to the override
   * layer (v+1). Absent for other mechanisms. Safety (防 prompt 自我繁殖): the LLM
   * only drafts here; the operator approves; the override never touches base; and
   * it is always rollback-able.
   */
  contentDraft?: {
    proposedContent: string;
    rationale: string;
  };
  /** Version the LLM read when drafting this content-version decision. */
  sourceVersion?: number;
  /** For a rollback action: the prior version ordinal to revert to (v1 = base). */
  rollbackToVersion?: number;
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
  /** Frozen counterexample annotation ids backing this evaluation conclusion. */
  counterexampleAnchors: string[];
  /**
   * Cryptographic digest of each target segment's injection states in the
   * immutable evaluation corpus. Retained as audit provenance; governance does
   * not create a separate treatment/verification window from it.
   */
  segmentTraceHashes: Record<string, string>;
  window: { start: number; end: number };
  evaluatedAt: number;
}
