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

import type { Candidate, GovernanceOutcome, JudgmentCommittedEvent, SegmentVerdict } from '@cat-cafe/shared';
import type { EvaluationCatalog } from '../evaluation/evaluation-catalog.js';
import type { CandidateStore } from './CandidateStore.js';

export interface GovernanceWorkerDeps {
  candidateStore: CandidateStore;
  catalog: EvaluationCatalog;
}

export function createGovernanceWorker(deps: GovernanceWorkerDeps): (event: JudgmentCommittedEvent) => Promise<void> {
  const { candidateStore, catalog } = deps;
  return async (event: JudgmentCommittedEvent): Promise<void> => {
    try {
      if (governanceOutcomeForVerdict(event.verdict) !== 'intervention_candidate') return;

      // Only open Candidates for segments the eval catalog actually governs.
      const governed = new Set(catalog.manifest.units.map((unit) => unit.unitId));
      const segmentIds = [
        ...new Set(event.unitRefs.filter((ref) => ref.unitType === 'segment').map((ref) => ref.unitId)),
      ].filter((segmentId) => governed.has(segmentId));

      for (const segmentId of segmentIds) {
        const candidateId = await candidateStore.nextCandidateId();
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
        await candidateStore.create(candidate);
      }
    } catch {
      /* fail-open: a governance-worker failure must not break the eval commit. */
    }
  };
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
