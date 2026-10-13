import { createHash } from 'node:crypto';
import type { DevelopmentReturnRegistrationV1, TaskItem, ThreadProposal } from '@cat-cafe/shared';
import { sameDevelopmentScopeSnapshot } from '../../../domains/ball-custody/action-subject-delegate-contract.js';
import {
  delegateLineageGenerationWasSuperseded,
  delegateLineageHasProposalAnchor,
  delegateLineageHistoryMatchesCanonicalOwner,
  isCurrentDelegateLineageGeneration,
} from '../../../domains/ball-custody/action-successor-delegate-lineage.js';
import { readDurableLocalReviewFact } from '../../../domains/cats/services/local-review-artifact.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import {
  canonicalGrowingSourceJson,
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

type Deps = Pick<DevelopmentReturnDeps, 'tasks' | 'messages' | 'readReviewProvenance'>;

const actionLeaseSourcePattern = /^action-lease:([A-Za-z0-9_-]{1,200}):([1-9]\d*)$/;

export function parseDevelopmentReturnActionLeaseRef(
  sourceActionRef: string,
): { leaseId: string; generation: number } | null {
  const match = actionLeaseSourcePattern.exec(sourceActionRef);
  if (!match) return null;
  const leaseId = match[1];
  if (!leaseId) return null;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) ? { leaseId, generation } : null;
}

function currentOriginal(message: StoredMessage | null, actor: DevelopmentWorkActor): message is StoredMessage {
  return (
    !!message &&
    message.userId === actor.userId &&
    message.threadId === actor.threadId &&
    !message.deletedAt &&
    !message._tombstone &&
    !message.source
  );
}

async function hasHumanAuthority(deps: Deps, actor: DevelopmentWorkActor, task: TaskItem, source: StoredMessage) {
  const sourceRef = `message:${source.id}`;
  return (
    task.entrustedWork?.admission.sourceRefs.includes(sourceRef) ||
    (await deps.tasks.hasDevelopmentSource({
      actor,
      taskId: task.id,
      sourceRef,
      sourceRevision: deriveGrowingSourceMessageRevision(source),
    }))
  );
}

/** Resolve a relation, never infer an authorization from prose or a reviewer verdict. */
export async function resolveDevelopmentReturnSource(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage | null,
): Promise<{ sourceMessageRevision: string } | null> {
  if (!currentOriginal(trigger, actor)) return null;
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(trigger);
  if (trigger.catId === null) {
    return (await hasHumanAuthority(deps, actor, task, trigger)) ? { sourceMessageRevision } : null;
  }
  const fact = readDurableLocalReviewFact(trigger);
  if (
    !fact ||
    fact.verdict !== 'approved' ||
    fact.reviewerCatId === actor.catId ||
    fact.reviewSubjectRef !== `task:work:${task.id}` ||
    fact.acceptedSourceRef !== `${actor.threadId}#${fact.acceptedRevision}` ||
    proposal.createdBy !== actor.userId ||
    proposal.approvedBy !== actor.userId ||
    proposal.approvedAt === undefined ||
    trigger.timestamp > proposal.approvedAt
  )
    return null;
  if (!deps.readReviewProvenance) throw new Error('Recorded review provenance reader is unavailable');
  const provenance = await deps.readReviewProvenance({
    userId: actor.userId,
    threadId: actor.threadId,
    authorCatId: actor.catId,
    reviewMessageId: trigger.id,
  });
  if (!provenance || provenance.recordedAt > proposal.approvedAt) return null;
  const human = await deps.messages.getById(fact.acceptedRevision);
  if (
    !currentOriginal(human, actor) ||
    human.catId !== null ||
    human.timestamp > trigger.timestamp ||
    !(await hasHumanAuthority(deps, actor, task, human))
  )
    return null;
  // Keep the strict persisted v1 shape readable by previous binaries. A reviewed
  // source revision pins the complete verified relation, not just the message body.
  // Storage fences reviewed registrations away from binaries lacking this resolver.
  return {
    sourceMessageRevision: `sha256:${createHash('sha256')
      .update(
        canonicalGrowingSourceJson({
          kind: 'recorded-task-review-v1',
          triggerRevision: sourceMessageRevision,
          humanSourceRef: `message:${human.id}`,
          humanSourceRevision: deriveGrowingSourceMessageRevision(human),
          fact,
          provenance,
          proposalApprovedAt: proposal.approvedAt,
        }),
      )
      .digest('hex')}`,
  };
}

/**
 * Resolve a returned ActionSuccessor generation as the reporter authority for
 * a sequential final-only return. The action lease does not replace the Task or
 * proposal: it proves that an approved child entered the canonical owner's
 * durable lineage and that this exact generation is current in that child-local
 * segment. Earlier child segments remain history, not a lifetime route veto.
 */
export async function resolveReturnedActionSuccessorReturnSource(
  deps: Deps & Pick<DevelopmentReturnDeps, 'actionSuccessors'>,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  executionThreadId: string,
  sourceActionRef: string,
  originalTrigger: StoredMessage | null,
): Promise<{ sourceMessageRevision: string; reporterCatIds: string[] } | null> {
  const resolution = await resolveReturnedActionSuccessorReturnStatus(
    deps,
    actor,
    task,
    proposal,
    executionThreadId,
    sourceActionRef,
    originalTrigger,
  );
  return resolution?.kind === 'current'
    ? {
        sourceMessageRevision: resolution.sourceMessageRevision,
        reporterCatIds: resolution.reporterCatIds,
      }
    : null;
}

export type ReturnedActionSuccessorReturnStatus =
  | { kind: 'current'; sourceMessageRevision: string; reporterCatIds: string[] }
  | { kind: 'superseded' };

/**
 * Resolve the exact active reporter, or prove that the bound reporter explicitly
 * returned that generation to the same owner/child lineage. A merely stale or
 * missing generation is not supersession proof.
 */
export async function resolveReturnedActionSuccessorReturnStatus(
  deps: Deps & Pick<DevelopmentReturnDeps, 'actionSuccessors'>,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  executionThreadId: string,
  sourceActionRef: string,
  originalTrigger: StoredMessage | null,
  expectedReporterCatIds?: readonly string[],
): Promise<ReturnedActionSuccessorReturnStatus | null> {
  const coordinate = parseDevelopmentReturnActionLeaseRef(sourceActionRef);
  if (!coordinate || !deps.actionSuccessors) return null;
  if (
    proposal.status !== 'approved' ||
    proposal.subjectTaskId !== task.id ||
    !sameDevelopmentScopeSnapshot(proposal.approvedDevelopmentScope, task.entrustedWork?.developmentScope)
  )
    return null;
  const [lease, originalSource] = await Promise.all([
    deps.actionSuccessors.get(coordinate.leaseId),
    resolveDevelopmentReturnSource(deps, actor, task, proposal, originalTrigger),
  ]);
  if (!lease || !originalSource) return null;
  const replacementTransitions = lease.replacementTransitions ?? [];
  const reporterCatIds = [...new Set(lease.holderCatIds)];
  const lineageRoute = {
    ownerCatId: actor.catId,
    ownerThreadId: actor.threadId,
    childThreadId: executionThreadId,
  };
  const delegateAnchor = proposal.preferredCats
    .map((catId) => ({
      catId,
      threadId: executionThreadId,
      evidenceRef: `proposal:${proposal.proposalId}:approved:thread:${executionThreadId}:cat:${catId}`,
    }))
    .find((anchor) => delegateLineageHasProposalAnchor(lease, anchor));
  const expectedDelegateEvidence = delegateAnchor?.evidenceRef;
  const canonicalHistory = delegateLineageHistoryMatchesCanonicalOwner(lease, lineageRoute);
  if (
    (lease.returnTransitions ?? []).length === 0 ||
    !canonicalHistory ||
    !expectedDelegateEvidence ||
    !lease.evidenceRefs.includes(expectedDelegateEvidence)
  ) {
    return null;
  }
  const terminalPredicate = lease.terminalPredicate;
  if (
    lease.tenantScope !== actor.userId ||
    lease.subjectRef !== `subject:task:${task.id}` ||
    lease.actionFamily !== 'implement' ||
    lease.successorSlot !== 'implementer' ||
    lease.mode !== 'single' ||
    lease.claimOrigin !== 'structured_transfer' ||
    terminalPredicate?.kind !== 'task_done' ||
    terminalPredicate.subjectRef !== `subject:task:${task.id}` ||
    !lease.issuerStandingEvidenceRef.trim() ||
    !lease.evidenceRefs.includes(lease.issuerStandingEvidenceRef)
  ) {
    return null;
  }

  if (
    !isCurrentDelegateLineageGeneration({
      lease,
      route: lineageRoute,
      generation: coordinate.generation,
      reporterCatIds,
    })
  ) {
    return delegateLineageGenerationWasSuperseded({
      lease,
      route: lineageRoute,
      generation: coordinate.generation,
      expectedReporterCatIds,
    })
      ? { kind: 'superseded' }
      : null;
  }

  return {
    kind: 'current',
    reporterCatIds,
    sourceMessageRevision: `sha256:${createHash('sha256')
      .update(
        canonicalGrowingSourceJson({
          kind: 'returned-action-successor-v1',
          originalSourceRevision: originalSource.sourceMessageRevision,
          proposalId: proposal.proposalId,
          executionThreadId,
          sourceActionRef,
          leaseId: lease.leaseId,
          generation: lease.generation,
          reporterCatIds,
          predecessorCatId: lease.predecessorCatId,
          predecessorThreadId: lease.predecessorThreadId,
          issuerStandingEvidenceRef: lease.issuerStandingEvidenceRef,
          returnTransitions: lease.returnTransitions,
          replacementTransitions,
          terminalPredicateDigest: terminalPredicate.digest,
          delegateEvidenceRef: expectedDelegateEvidence,
        }),
      )
      .digest('hex')}`,
  };
}

export function sameDevelopmentReturnSource(
  state: DevelopmentReturnRegistrationV1,
  source: Awaited<ReturnType<typeof resolveDevelopmentReturnSource>>,
): boolean {
  return !!source && source.sourceMessageRevision === state.sourceMessageRevision;
}
