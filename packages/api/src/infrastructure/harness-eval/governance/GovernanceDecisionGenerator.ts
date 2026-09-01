/**
 * F257 content→v2 — the injected LLM governance-decision step.
 *
 * Operator-confirmed model (2026-09-01, feat doc "当前治理模型"): after an eval
 * Unit-run commits a verdict, governance looks at THIS round's metrics +
 * conclusion and the LLM drafts ONE decision:
 *   - `change-content` → propose a new segment content version (v+1);
 *   - `rollback`       → revert to a prior version;
 *   - `skip`           → keep the current version, accumulate more evidence.
 *
 * The decision is a PROPOSAL only. The operator approves/rejects it before
 * anything is written (防 prompt 自我繁殖: the LLM only drafts here; the operator
 * approves; the override never touches base; it is always rollback-able). There
 * is NO PatchTrial/固化 verification ring — the NEXT round's normal eval is the
 * verification, feeding the next governance decision.
 *
 * The generator is dependency-injected (mirroring `SemanticEvaluator`): the real
 * Anthropic-backed adapter is wired at server bootstrap; tests inject a stub.
 */

import type { GovernanceDecisionAction, ObjectiveVerdictDecision, SegmentVerdict } from '@cat-cafe/shared';

export interface GovernanceDecisionInput {
  segmentId: string;
  objectiveId: string;
  /** The current effective segment content (current version, or base[0]). */
  currentContent: string;
  /** Current version ordinal (1 = base). */
  currentVersion: number;
  /** This round's rolled-up verdict + metric decisions. */
  verdict: SegmentVerdict;
  verdictDecision: ObjectiveVerdictDecision;
  /** Human-readable conclusion the drafter reasons from. */
  conclusion: string;
  /** Anchors into the frozen counterexample corpus backing the conclusion. */
  counterexampleAnchors: readonly string[];
}

export interface GovernanceDecision {
  action: GovernanceDecisionAction;
  /** Required iff action === 'change-content'. */
  contentDraft?: { proposedContent: string; rationale: string };
  /** Required iff action === 'rollback': the prior version ordinal to revert to (>= 1). */
  rollbackToVersion?: number;
  /** One-paragraph rationale tying the decision to this round's conclusion. */
  rationale: string;
}

export interface GovernanceDecisionGenerator {
  decide(input: GovernanceDecisionInput): Promise<GovernanceDecision>;
}

/**
 * Validate a generator's decision is well-formed for its action (fail-closed: a
 * malformed content/rollback draft must never reach the operator card). Returns
 * the decision on success; throws on mismatch.
 */
export function assertValidGovernanceDecision(decision: GovernanceDecision): GovernanceDecision {
  if (typeof decision.rationale !== 'string' || decision.rationale.trim() === '') {
    throw new Error('governance_decision_requires_rationale');
  }
  if (decision.action === 'change-content') {
    const content = decision.contentDraft?.proposedContent;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('governance_decision_change_content_requires_nonempty_proposed_content');
    }
    if (typeof decision.contentDraft?.rationale !== 'string' || decision.contentDraft.rationale.trim() === '') {
      throw new Error('governance_decision_change_content_requires_draft_rationale');
    }
  }
  if (
    decision.action === 'rollback' &&
    (typeof decision.rollbackToVersion !== 'number' ||
      !Number.isInteger(decision.rollbackToVersion) ||
      decision.rollbackToVersion < 1)
  ) {
    throw new Error('governance_decision_rollback_requires_prior_version_ordinal');
  }
  return decision;
}

/**
 * Deterministic default/stub: always `skip`. Used in tests and as the fail-safe
 * default until the Anthropic-backed adapter is wired at bootstrap — an unwired
 * generator must never fabricate a content change.
 */
export class SkipGovernanceDecisionGenerator implements GovernanceDecisionGenerator {
  async decide(_input: GovernanceDecisionInput): Promise<GovernanceDecision> {
    return { action: 'skip', rationale: 'No content-draft adapter wired — defaulting to skip (accumulate).' };
  }
}
