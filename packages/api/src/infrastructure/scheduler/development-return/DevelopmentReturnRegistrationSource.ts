import type {
  DevelopmentReturnActionV1,
  DevelopmentReturnRegistrationV1,
  TaskItem,
  ThreadProposal,
} from '@cat-cafe/shared';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';
import {
  parseDevelopmentReturnActionLeaseRef,
  resolveDevelopmentReturnSource,
  resolveReturnedActionSuccessorReturnStatus,
} from './DevelopmentReturnSource.js';

type RegistrationSourceDeps = Pick<
  DevelopmentReturnDeps,
  'tasks' | 'messages' | 'definitions' | 'readReviewProvenance' | 'actionSuccessors'
>;
type CurrentDevelopmentTask = TaskItem & {
  entrustedWork: NonNullable<TaskItem['entrustedWork']> & {
    developmentScope: NonNullable<NonNullable<TaskItem['entrustedWork']>['developmentScope']>;
  };
};
export type DevelopmentReturnRegistrationInput = DevelopmentReturnActionV1 &
  Required<
    Pick<
      DevelopmentReturnActionV1,
      'taskId' | 'expectedRevision' | 'executionThreadId' | 'sourceActionRef' | 'expectedSignal' | 'slaUntil'
    >
  >;

export function assertDevelopmentReturnRegistrationInput(
  input: DevelopmentReturnActionV1,
  now: number,
): asserts input is DevelopmentReturnRegistrationInput {
  if (
    !input.taskId ||
    !input.expectedRevision ||
    !input.executionThreadId ||
    !input.sourceActionRef ||
    input.expectedSignal !== 'terminal_report' ||
    !input.slaUntil ||
    input.slaUntil <= now ||
    input.slaUntil > now + 7 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('Return registration needs exact coordinates and a future SLA within 7 days');
  }
}

function activePredecessorSupersession(input: {
  deps: RegistrationSourceDeps;
  actor: DevelopmentWorkActor;
  task: CurrentDevelopmentTask;
  proposal: ThreadProposal;
  child: Thread;
  actionLeaseCoordinate: { leaseId: string; generation: number };
  predecessorRegistrationId: string | undefined;
  returnedStatus: Extract<Awaited<ReturnType<typeof resolveReturnedActionSuccessorReturnStatus>>, { kind: 'current' }>;
}): DevelopmentReturnRegistrationV1 | undefined {
  const predecessor = input.predecessorRegistrationId
    ? input.deps.definitions.getPrivateExecutionReturn(input.predecessorRegistrationId)
    : null;
  const superseded = input.returnedStatus.supersededPredecessor;
  if (
    !predecessor ||
    !superseded ||
    predecessor.status !== 'waiting' ||
    predecessor.reason !== undefined ||
    predecessor.report !== undefined ||
    predecessor.wakeMessageId !== undefined ||
    predecessor.deliveryRevision !== undefined ||
    predecessor.ownerUserId !== input.actor.userId ||
    predecessor.ownerThreadId !== input.actor.threadId ||
    predecessor.ownerCatId !== input.actor.catId ||
    predecessor.taskRef !== `task:work:${input.task.id}` ||
    predecessor.proposalId !== input.proposal.proposalId ||
    predecessor.executionThreadId !== input.child.id ||
    JSON.stringify(predecessor.reporterCatIds) !== JSON.stringify(superseded.reporterCatIds)
  ) {
    return undefined;
  }
  const predecessorLease = parseDevelopmentReturnActionLeaseRef(predecessor.sourceActionRef);
  const sourceMatches = predecessorLease
    ? predecessorLease.leaseId === input.actionLeaseCoordinate.leaseId &&
      predecessorLease.generation === superseded.generation
    : superseded.generation === 1 && predecessor.sourceActionRef === `message:${input.proposal.sourceMessageId}`;
  return sourceMatches ? predecessor : undefined;
}

export async function resolveDevelopmentReturnRegistrationSource(input: {
  deps: RegistrationSourceDeps;
  actor: DevelopmentWorkActor;
  task: CurrentDevelopmentTask;
  proposal: ThreadProposal;
  child: Thread;
  source: StoredMessage | null;
  action: DevelopmentReturnRegistrationInput;
}) {
  const actionLeaseCoordinate = parseDevelopmentReturnActionLeaseRef(input.action.sourceActionRef);
  const returnedStatus = actionLeaseCoordinate
    ? await resolveReturnedActionSuccessorReturnStatus(
        input.deps,
        input.actor,
        input.task,
        input.proposal,
        input.child.id,
        input.action.sourceActionRef,
        input.source,
      )
    : null;
  const returnedSource =
    returnedStatus?.kind === 'current'
      ? {
          sourceMessageRevision: returnedStatus.sourceMessageRevision,
          reporterCatIds: returnedStatus.reporterCatIds,
        }
      : null;
  const sourceBinding =
    returnedSource ??
    (await resolveDevelopmentReturnSource(input.deps, input.actor, input.task, input.proposal, input.source));
  if (
    !input.source ||
    !sourceBinding ||
    (actionLeaseCoordinate
      ? !input.action.predecessorRegistrationId || !returnedSource
      : input.action.sourceActionRef !== `message:${input.proposal.sourceMessageId}`)
  ) {
    throw new Error('Original human source or returned action generation is unavailable');
  }
  const predecessorSupersession =
    actionLeaseCoordinate && returnedStatus?.kind === 'current'
      ? activePredecessorSupersession({
          deps: input.deps,
          actor: input.actor,
          task: input.task,
          proposal: input.proposal,
          child: input.child,
          actionLeaseCoordinate,
          predecessorRegistrationId: input.action.predecessorRegistrationId,
          returnedStatus,
        })
      : undefined;
  return {
    source: input.source,
    sourceBinding,
    reporterCatIds: returnedSource?.reporterCatIds ?? input.proposal.preferredCats,
    hasReturnedSource: Boolean(returnedSource),
    ...(predecessorSupersession ? { predecessorSupersession } : {}),
  };
}
