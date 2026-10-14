import { successorReplace } from '../../infrastructure/telemetry/instruments.js';
import type {
  ActionSuccessorAdmissionInput,
  ActionSuccessorAdmissionResult,
} from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import type { CanonicalActionTerminalPredicate } from './ActionTerminalPredicateCatalog.js';
import {
  currentDelegateLineageGenerationHasExactEntry,
  isTerminalDelegateLineageOutcome,
} from './action-successor-delegate-lineage.js';
import {
  type ActionSuccessorLease,
  isReturnedActionSuccessorHolderGeneration,
  type ReturnedActionSuccessorProof,
} from './action-successor-state-machine.js';

type ClaimOrigin = 'structured_transfer' | 'existing_standing';

type ReturnedReplacementResolution =
  | { kind: 'ordinary' }
  | { kind: 'proof_required' }
  | { kind: 'authorized'; proof: ReturnedActionSuccessorProof };

interface ReplacementAdmissionDeps {
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get' | 'replace'>;
  resolveIssuerStanding(input: ActionSuccessorAdmissionInput, claimOrigin: ClaimOrigin): string;
  resolveVerifiedPredicate(
    input: ActionSuccessorAdmissionInput,
    current: ActionSuccessorLease,
    delegateLineageReentry: boolean,
  ): Promise<{
    terminalPredicate: CanonicalActionTerminalPredicate;
    freshnessEvidenceRef: string;
    /** F167 × F322: delegate authority evidence for lease auditability. */
    delegateEvidenceRef?: string;
  }>;
  admitted(
    outcome: 'replaced' | 'reattached',
    lease: ActionSuccessorLease,
    dispatchId: string,
  ): ActionSuccessorAdmissionResult;
  resolveTerminalCas(input: ActionSuccessorAdmissionInput): Promise<ActionSuccessorAdmissionResult>;
}

function resolveReturnedReplacement(
  current: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
  claimOrigin: ClaimOrigin,
): ReturnedReplacementResolution {
  if (!isReturnedActionSuccessorHolderGeneration(current)) return { kind: 'ordinary' };
  const transition = current.returnTransitions.at(-1);
  if (
    claimOrigin !== 'structured_transfer' ||
    !transition ||
    current.holderCatIds.length !== 1 ||
    current.holderCatIds[0] !== input.actorCatId ||
    current.holderThreadId !== input.sourceThreadId ||
    transition.predecessorCatId !== input.actorCatId ||
    transition.predecessorThreadId !== input.sourceThreadId
  ) {
    throw new Error('returned-holder replacement must originate from the exact returned holder route');
  }
  if (
    input.incomingActionLeaseRef?.leaseId === current.leaseId &&
    input.incomingActionLeaseRef.generation === current.generation
  ) {
    return {
      kind: 'authorized',
      proof: {
        kind: 'returned_fence',
        leaseId: input.incomingActionLeaseRef.leaseId,
        generation: input.incomingActionLeaseRef.generation,
      },
    };
  }
  if (current.returnDeliveryState === 'delivered' && current.returnDeliveryEvidenceRef) {
    return {
      kind: 'authorized',
      proof: { kind: 'return_delivery', evidenceRef: current.returnDeliveryEvidenceRef },
    };
  }
  return { kind: 'proof_required' };
}

function assertOrdinaryReplacementRoute(
  current: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
  claimOrigin: ClaimOrigin,
): void {
  if (claimOrigin === 'existing_standing') {
    if (current.holderThreadId !== input.sourceThreadId) {
      throw new Error('existing-standing replacement must originate from the persisted holder thread');
    }
    return;
  }
  if (current.predecessorCatId !== input.actorCatId || current.predecessorThreadId !== input.sourceThreadId) {
    throw new Error('replacement must originate from the persisted issuer route');
  }
}

/** Server-derived interruption proof, passed on only when it names exactly the lease and generation being replaced. */
function interruptedGenerationFor(
  input: ActionSuccessorAdmissionInput,
  replacement: { leaseId: string; expectedGeneration: number },
): { generation: number; evidenceRef: string } | undefined {
  const proof = input.interruptedGenerationEvidence;
  if (proof?.leaseId !== replacement.leaseId || proof.generation !== replacement.expectedGeneration) return undefined;
  return { generation: proof.generation, evidenceRef: proof.evidenceRef };
}

function isDelegateLineageReplacement(
  current: ActionSuccessorLease,
  input: ActionSuccessorAdmissionInput,
  claimOrigin: ClaimOrigin,
  returnedReplacement: ReturnedReplacementResolution,
  interruptedGeneration: ReturnType<typeof interruptedGenerationFor>,
): boolean {
  if (returnedReplacement.kind === 'authorized') return true;
  if (
    claimOrigin !== 'structured_transfer' ||
    current.mode !== 'single' ||
    current.holderCatIds.length !== 1 ||
    current.predecessorCatId !== input.actorCatId ||
    current.predecessorThreadId !== input.sourceThreadId
  ) {
    return false;
  }
  const lineageRoute = {
    ownerCatId: input.actorCatId,
    ownerThreadId: input.sourceThreadId,
    childThreadId: current.holderThreadId,
  };
  if (!currentDelegateLineageGenerationHasExactEntry(current, lineageRoute)) {
    return false;
  }
  if (interruptedGeneration) {
    return (
      current.status === 'active' &&
      Object.keys(current.holderOutcomes).length === 0 &&
      Object.keys(current.completionCandidates).length === 0
    );
  }
  const holderOutcome = current.holderOutcomes[current.holderCatIds[0] ?? ''];
  return (
    current.status === 'replaceable' &&
    Object.keys(current.holderOutcomes).length === 1 &&
    Object.keys(current.completionCandidates).length === 0 &&
    isTerminalDelegateLineageOutcome(holderOutcome?.outcome)
  );
}

export async function admitActionSuccessorReplacement(
  identityKey: string,
  input: ActionSuccessorAdmissionInput,
  deps: ReplacementAdmissionDeps,
): Promise<ActionSuccessorAdmissionResult> {
  const replacement = input.action.replace;
  if (!replacement) throw new Error('replacement metadata missing');
  const current = await deps.leaseStore.get(replacement.leaseId);
  if (!current) throw new Error(`replacement lease not found: ${replacement.leaseId}`);
  if (current.key !== identityKey) throw new Error('replacement lease identity mismatch');
  const claimOrigin = input.action.claimOrigin ?? 'structured_transfer';
  if (current.claimOrigin !== claimOrigin) {
    throw new Error('replacement claim origin must match the persisted lease');
  }
  const issuerStandingEvidenceRef = deps.resolveIssuerStanding(input, claimOrigin);
  const returnedReplacement = resolveReturnedReplacement(current, input, claimOrigin);
  if (returnedReplacement.kind === 'proof_required') {
    return { admit: false, outcome: 'return_proof_required', lease: current };
  }
  if (returnedReplacement.kind === 'ordinary') assertOrdinaryReplacementRoute(current, input, claimOrigin);
  const interruptedGeneration = interruptedGenerationFor(input, replacement);
  const delegateLineageReentry = isDelegateLineageReplacement(
    current,
    input,
    claimOrigin,
    returnedReplacement,
    interruptedGeneration,
  );
  const { terminalPredicate, freshnessEvidenceRef, delegateEvidenceRef } = await deps.resolveVerifiedPredicate(
    input,
    current,
    delegateLineageReentry,
  );
  const replacementInput = {
    expectedGeneration: replacement.expectedGeneration,
    ...(interruptedGeneration ? { interruptedGeneration } : {}),
    holderCatIds: input.holderCatIds,
    holderThreadId: input.targetThreadId,
    dispatchId: input.dispatchId,
    terminalPredicate,
    evidenceRef: input.evidenceRef,
    freshnessEvidenceRef,
    ...(delegateEvidenceRef ? { delegateEvidenceRef } : {}),
    now: input.now,
  };
  const result = await deps.leaseStore.replace(
    replacement.leaseId,
    claimOrigin === 'existing_standing'
      ? { ...replacementInput, claimOrigin, issuerStandingEvidenceRef }
      : {
          ...replacementInput,
          claimOrigin,
          predecessorCatId: input.actorCatId,
          predecessorThreadId: input.sourceThreadId,
          issuerStandingEvidenceRef,
          ...(returnedReplacement.kind === 'authorized'
            ? {
                returnedHolderCatId: input.actorCatId,
                returnedHolderThreadId: input.sourceThreadId,
                returnProof: returnedReplacement.proof,
              }
            : {}),
        },
  );
  if (result.outcome === 'replaced' || result.outcome === 'reattached') {
    successorReplace.add(1);
    return deps.admitted(result.outcome, result.lease, input.dispatchId);
  }
  if (result.outcome === 'subject_terminal') return deps.resolveTerminalCas(input);
  return { admit: false, outcome: result.outcome, lease: result.lease };
}
