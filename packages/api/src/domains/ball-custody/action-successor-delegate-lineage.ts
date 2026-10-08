import {
  isTerminalDelegateLineageOutcome,
  replacementTransitionMatchesCanonicalOwnerRoute,
  replacementTransitionMatchesDelegateLineage,
  sameSingleActionSuccessorHolder,
} from './action-successor-delegate-lineage-transition.js';
import { carrierRefreshEvidenceRef } from './action-successor-refresh-state-machine.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export {
  isTerminalDelegateLineageOutcome,
  replacementTransitionMatchesCanonicalOwnerRoute,
  replacementTransitionMatchesDelegateLineage,
  sameSingleActionSuccessorHolder,
} from './action-successor-delegate-lineage-transition.js';

export interface ActionSuccessorDelegateLineageRoute {
  ownerCatId: string;
  ownerThreadId: string;
  childThreadId: string;
}

export interface ActionSuccessorDelegateLineageAnchor {
  catId: string;
  threadId: string;
  evidenceRef: string;
}

type ActionSuccessorLineageArrays = Partial<Pick<ActionSuccessorLease, 'replacementTransitions' | 'returnTransitions'>>;
type ActionSuccessorLineageHistory = Pick<ActionSuccessorLease, 'evidenceRefs' | 'generation' | 'leaseId'> &
  ActionSuccessorLineageArrays;

const NO_RETURN_TRANSITIONS: ActionSuccessorLease['returnTransitions'] = [];
const NO_REPLACEMENT_TRANSITIONS: ActionSuccessorLease['replacementTransitions'] = [];

function returnTransitionsOf(lease: ActionSuccessorLineageArrays) {
  return lease.returnTransitions ?? NO_RETURN_TRANSITIONS;
}

function replacementTransitionsOf(lease: ActionSuccessorLineageArrays) {
  return lease.replacementTransitions ?? NO_REPLACEMENT_TRANSITIONS;
}

function delegateLineageGenerationHasExactEntry(input: {
  lease: ActionSuccessorLineageHistory;
  route: Pick<ActionSuccessorDelegateLineageRoute, 'ownerCatId' | 'ownerThreadId'>;
  generation: number;
  holderCatIds: readonly string[] | undefined;
  holderThreadId: string | undefined;
}): boolean {
  const { lease, route, generation, holderCatIds, holderThreadId } = input;
  if (generation <= 1 || holderCatIds?.length !== 1 || !holderCatIds[0]?.trim() || !holderThreadId?.trim()) {
    return false;
  }
  if (returnTransitionsOf(lease).some((transition) => transition.toGeneration + 1 === generation)) {
    return true;
  }
  const replacementEntry = replacementTransitionsOf(lease).some(
    (transition) =>
      transition.toGeneration === generation &&
      transition.toHolderThreadId === holderThreadId &&
      sameSingleActionSuccessorHolder(transition.toHolderCatIds, holderCatIds) &&
      replacementTransitionMatchesCanonicalOwnerRoute(transition, route),
  );
  if (replacementEntry) return true;
  return delegateLineageGenerationHasExactRefreshEntry({
    lease,
    route,
    generation,
    holderCatIds,
    holderThreadId,
  });
}

function delegateLineageGenerationHasExactRefreshEntry(input: {
  lease: ActionSuccessorLineageHistory;
  route: Pick<ActionSuccessorDelegateLineageRoute, 'ownerCatId' | 'ownerThreadId'>;
  generation: number;
  holderCatIds: readonly string[];
  holderThreadId: string;
}): boolean {
  const { lease, generation } = input;
  if (!lease.evidenceRefs.includes(carrierRefreshEvidenceRef(lease.leaseId, generation))) return false;
  if (replacementTransitionsOf(lease).some((transition) => transition.toGeneration === generation)) return false;
  if (returnTransitionsOf(lease).some((transition) => transition.fromGeneration < generation)) return false;
  if (generation === 2) return true;
  return delegateLineageGenerationHasExactEntry({ ...input, generation: generation - 1 });
}

function returnTransitionMatchesCanonicalOwnerRoute(
  transition: ActionSuccessorLease['returnTransitions'][number],
  route: Pick<ActionSuccessorDelegateLineageRoute, 'ownerCatId' | 'ownerThreadId'>,
): boolean {
  return (
    transition.fromGeneration >= 1 &&
    transition.toGeneration === transition.fromGeneration + 1 &&
    Boolean(transition.rejectingCatId.trim()) &&
    Boolean(transition.rejectingThreadId?.trim()) &&
    transition.predecessorCatId === route.ownerCatId &&
    transition.predecessorThreadId === route.ownerThreadId &&
    Boolean(transition.groundingEvidenceRef.trim()) &&
    Number.isFinite(transition.at)
  );
}

export function delegateLineageHistoryMatchesCanonicalOwner(
  lease: ActionSuccessorLineageHistory,
  route: Pick<ActionSuccessorDelegateLineageRoute, 'ownerCatId' | 'ownerThreadId'>,
): boolean {
  const returnTransitions = returnTransitionsOf(lease);
  const replacementTransitions = replacementTransitionsOf(lease);
  const edges = [...returnTransitions, ...replacementTransitions];
  const fromGenerations = new Set<number>();
  if (!returnTransitions.every((transition) => returnTransitionMatchesCanonicalOwnerRoute(transition, route))) {
    return false;
  }
  if (
    !replacementTransitions.every((transition) => replacementTransitionMatchesCanonicalOwnerRoute(transition, route))
  ) {
    return false;
  }
  for (const transition of edges) {
    if (transition.toGeneration > lease.generation) return false;
    if (fromGenerations.has(transition.fromGeneration)) return false;
    fromGenerations.add(transition.fromGeneration);
    if (transition.fromGeneration === 1) continue;
    const holderCatIds = 'fromHolderCatIds' in transition ? transition.fromHolderCatIds : [transition.rejectingCatId];
    const holderThreadId =
      'fromHolderThreadId' in transition ? transition.fromHolderThreadId : transition.rejectingThreadId;
    if (
      !delegateLineageGenerationHasExactEntry({
        lease,
        route,
        generation: transition.fromGeneration,
        holderCatIds,
        holderThreadId,
      })
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A child proposal anchors its first admitted cat, while later same-child
 * successors may differ. The anchor must be server-derived lease evidence plus
 * a durable observation of that exact cat/thread in the lineage.
 */
export function delegateLineageHasProposalAnchor(
  lease: Pick<
    ActionSuccessorLease,
    'evidenceRefs' | 'holderCatIds' | 'holderThreadId' | 'replacementTransitions' | 'returnTransitions'
  >,
  anchor: ActionSuccessorDelegateLineageAnchor,
): boolean {
  if (!lease.evidenceRefs.includes(anchor.evidenceRef)) return false;
  if (lease.holderThreadId === anchor.threadId && sameSingleActionSuccessorHolder(lease.holderCatIds, [anchor.catId])) {
    return true;
  }
  if (
    returnTransitionsOf(lease).some(
      (transition) => transition.rejectingCatId === anchor.catId && transition.rejectingThreadId === anchor.threadId,
    )
  ) {
    return true;
  }
  const replacementTransitions = replacementTransitionsOf(lease);
  if (
    replacementTransitions.some(
      (transition) =>
        transition.fromHolderThreadId === anchor.threadId &&
        sameSingleActionSuccessorHolder(transition.fromHolderCatIds, [anchor.catId]),
    )
  ) {
    return true;
  }
  return replacementTransitions.some(
    (transition) =>
      transition.toHolderThreadId === anchor.threadId &&
      sameSingleActionSuccessorHolder(transition.toHolderCatIds, [anchor.catId]),
  );
}

/**
 * Return and cross-child replacement edges delimit child-local lineage
 * segments. Historical segments remain auditable but cannot veto the current
 * child's valid terminal/interrupted successor recovery.
 */
export function currentDelegateLineageSegmentStartGeneration(
  lease: ActionSuccessorLease,
  route: ActionSuccessorDelegateLineageRoute,
): number | null {
  const currentRouteMatches =
    lease.mode === 'single' &&
    lease.holderCatIds.length === 1 &&
    lease.holderThreadId === route.childThreadId &&
    lease.predecessorCatId === route.ownerCatId &&
    lease.predecessorThreadId === route.ownerThreadId;
  if (!currentRouteMatches) return null;
  if (!delegateLineageHistoryMatchesCanonicalOwner(lease, route)) return null;

  const returnStarts = returnTransitionsOf(lease)
    .filter((transition) => transition.toGeneration < lease.generation)
    .map((transition) => transition.toGeneration + 1);
  const replacementStarts = replacementTransitionsOf(lease)
    .filter(
      (transition) =>
        transition.toGeneration <= lease.generation &&
        transition.fromHolderThreadId !== transition.toHolderThreadId &&
        transition.toHolderThreadId === route.childThreadId,
    )
    .map((transition) => transition.toGeneration);
  // The initial approved delegate is generation 1. A canonical same-child
  // g1→g2 terminal replacement is therefore the first exact entry edge even
  // when no explicit return preceded it.
  const startGeneration = Math.max(1, ...returnStarts, ...replacementStarts);
  if (startGeneration > lease.generation) return null;

  const currentSegmentMatches = replacementTransitionsOf(lease)
    .filter((transition) => transition.fromGeneration >= startGeneration)
    .every((transition) => replacementTransitionMatchesDelegateLineage(transition, route));
  return currentSegmentMatches ? startGeneration : null;
}

export function currentDelegateLineageGenerationHasExactEntry(
  lease: ActionSuccessorLease,
  route: ActionSuccessorDelegateLineageRoute,
): boolean {
  return (
    currentDelegateLineageSegmentStartGeneration(lease, route) !== null &&
    delegateLineageGenerationHasExactEntry({
      lease,
      route,
      generation: lease.generation,
      holderCatIds: lease.holderCatIds,
      holderThreadId: lease.holderThreadId,
    })
  );
}

export function boundGenerationHasTerminalDelegateOutcome(
  lease: ActionSuccessorLease,
  generation: number,
  expectedReporterCatIds: readonly string[] | undefined,
  childThreadId: string,
): boolean {
  if (
    lease.generation !== generation ||
    lease.status !== 'replaceable' ||
    lease.holderThreadId !== childThreadId ||
    !sameSingleActionSuccessorHolder(lease.holderCatIds, expectedReporterCatIds) ||
    Object.keys(lease.completionCandidates).length > 0
  ) {
    return false;
  }
  const outcomes = Object.values(lease.holderOutcomes);
  return outcomes.length === 1 && isTerminalDelegateLineageOutcome(outcomes[0]?.outcome);
}

export function isCurrentDelegateLineageGeneration(input: {
  lease: ActionSuccessorLease;
  route: ActionSuccessorDelegateLineageRoute;
  generation: number;
  reporterCatIds: readonly string[];
}): boolean {
  const { lease, route, generation, reporterCatIds } = input;
  return (
    lease.generation === generation &&
    lease.status === 'active' &&
    lease.holderThreadId === route.childThreadId &&
    reporterCatIds.length === 1 &&
    sameSingleActionSuccessorHolder(lease.holderCatIds, reporterCatIds) &&
    lease.predecessorCatId === route.ownerCatId &&
    lease.predecessorThreadId === route.ownerThreadId &&
    Object.keys(lease.holderOutcomes).length === 0 &&
    Object.keys(lease.completionCandidates).length === 0 &&
    currentDelegateLineageGenerationHasExactEntry(lease, route)
  );
}

export function delegateLineageGenerationWasSuperseded(input: {
  lease: ActionSuccessorLease;
  route: ActionSuccessorDelegateLineageRoute;
  generation: number;
  expectedReporterCatIds: readonly string[] | undefined;
}): boolean {
  const { lease, route, generation, expectedReporterCatIds } = input;
  if (!delegateLineageHistoryMatchesCanonicalOwner(lease, route)) return false;
  if (
    !delegateLineageGenerationHasExactEntry({
      lease,
      route,
      generation,
      holderCatIds: expectedReporterCatIds,
      holderThreadId: route.childThreadId,
    })
  ) {
    return false;
  }
  if (boundGenerationHasTerminalDelegateOutcome(lease, generation, expectedReporterCatIds, route.childThreadId)) {
    return true;
  }
  if (lease.generation <= generation) return false;
  const supersedingReturn = returnTransitionsOf(lease).some(
    (entry) =>
      entry.fromGeneration === generation &&
      entry.toGeneration === generation + 1 &&
      entry.rejectingCatId === expectedReporterCatIds?.[0] &&
      entry.rejectingThreadId === route.childThreadId &&
      entry.predecessorCatId === route.ownerCatId &&
      entry.predecessorThreadId === route.ownerThreadId,
  );
  if (supersedingReturn) return true;
  return replacementTransitionsOf(lease).some(
    (entry) =>
      entry.fromGeneration === generation &&
      sameSingleActionSuccessorHolder(entry.fromHolderCatIds, expectedReporterCatIds) &&
      entry.fromHolderThreadId === route.childThreadId &&
      replacementTransitionMatchesCanonicalOwnerRoute(entry, route),
  );
}
