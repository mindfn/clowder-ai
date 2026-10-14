import { createHash } from 'node:crypto';
import {
  type DevelopmentReturnActionV1,
  type DevelopmentReturnRegistrationV1,
  developmentReturnRegistrationV1Schema,
  type TaskItem,
  type ThreadProposal,
} from '@cat-cafe/shared';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import {
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';
import {
  parseDevelopmentReturnActionLeaseRef,
  resolveDevelopmentReturnSource,
  resolveReturnedActionSuccessorReturnSource,
  resolveReturnedActionSuccessorReturnStatus,
  sameDevelopmentReturnSource,
} from './DevelopmentReturnSource.js';

type AuthorityDeps = Pick<
  DevelopmentReturnDeps,
  'tasks' | 'threads' | 'proposals' | 'messages' | 'readReviewProvenance' | 'actionSuccessors'
>;
type Registration = DevelopmentReturnRegistrationV1;
type CurrentDevelopmentTask = TaskItem & {
  entrustedWork: NonNullable<TaskItem['entrustedWork']> & {
    developmentScope: NonNullable<NonNullable<TaskItem['entrustedWork']>['developmentScope']>;
  };
};

function isOpenTaskOwner(task: TaskItem | null, actor: DevelopmentWorkActor): task is CurrentDevelopmentTask {
  return Boolean(
    task &&
      task.userId === actor.userId &&
      task.threadId === actor.threadId &&
      task.ownerCatId === actor.catId &&
      task.entrustedWork?.developmentScope &&
      task.entrustedWork.closure.state === 'open' &&
      task.status !== 'done',
  );
}

function requireCurrentTaskOwner(
  task: TaskItem | null,
  actor: DevelopmentWorkActor,
  expectedRevision: number,
): CurrentDevelopmentTask {
  if (!isOpenTaskOwner(task, actor) || task.entrustedWork.revision !== expectedRevision)
    throw new Error('Current Task owner and revision are required');
  return task;
}

function isApprovedExecution(
  child: Thread | null,
  proposal: ThreadProposal | null,
  actor: DevelopmentWorkActor,
): child is Thread {
  return Boolean(
    child &&
      child.createdBy === actor.userId &&
      !child.deletedAt &&
      proposal &&
      proposal.status === 'approved' &&
      proposal.createdThreadId === child.id &&
      proposal.sourceThreadId === actor.threadId &&
      proposal.sourceCatId === actor.catId &&
      (proposal.reportingMode ?? 'final-only') === 'final-only' &&
      proposal.preferredCats.length > 0,
  );
}

function requireApprovedExecution(
  child: Thread | null,
  proposal: ThreadProposal | null,
  actor: DevelopmentWorkActor,
): { child: Thread; proposal: ThreadProposal } {
  if (!isApprovedExecution(child, proposal, actor) || !proposal)
    throw new Error('Return must bind the approved execution and its original source');
  return { child, proposal };
}

function isCurrentTerminalReport(
  report: StoredMessage | null,
  state: Registration,
  executionThreadId: string,
  proposal: ThreadProposal,
  proposalReporter: boolean,
): boolean {
  return Boolean(
    report &&
      !report.deletedAt &&
      !report._tombstone &&
      !report.source &&
      report.userId === state.ownerUserId &&
      report.threadId === executionThreadId &&
      report.catId !== null &&
      state.reporterCatIds.includes(report.catId) &&
      (!proposalReporter || proposal.preferredCats.includes(report.catId)) &&
      deriveGrowingSourceMessageRevision(report) === state.report?.sourceMessageRevision,
  );
}

function developmentReturnStorage(
  source: StoredMessage,
  hasReturnedSource: boolean,
): 'direct' | 'reviewed' | 'successor' {
  if (hasReturnedSource) return 'successor';
  return source.catId === null ? 'direct' : 'reviewed';
}

export async function prepareDevelopmentReturn(
  deps: AuthorityDeps,
  actor: DevelopmentWorkActor,
  input: DevelopmentReturnActionV1,
  now: number,
): Promise<{ registration: Registration; returnStorage: 'direct' | 'reviewed' | 'successor' }> {
  if (
    !input.taskId ||
    !input.expectedRevision ||
    !input.executionThreadId ||
    !input.sourceActionRef ||
    input.expectedSignal !== 'terminal_report' ||
    !input.slaUntil ||
    input.slaUntil <= now ||
    input.slaUntil > now + 7 * 24 * 60 * 60 * 1000
  )
    throw new Error('Return registration needs exact coordinates and a future SLA within 7 days');
  const task = requireCurrentTaskOwner(await deps.tasks.get(input.taskId), actor, input.expectedRevision);
  const candidateChild = await deps.threads.get(input.executionThreadId);
  const candidateProposal = candidateChild?.createdFromProposalId
    ? await deps.proposals.get(candidateChild.createdFromProposalId)
    : null;
  const { child, proposal } = requireApprovedExecution(candidateChild, candidateProposal, actor);
  const source = await deps.messages.getById(proposal.sourceMessageId ?? '');
  const actionLeaseCoordinate = parseDevelopmentReturnActionLeaseRef(input.sourceActionRef);
  const returnedSource = actionLeaseCoordinate
    ? await resolveReturnedActionSuccessorReturnSource(
        deps,
        actor,
        task,
        proposal,
        child.id,
        input.sourceActionRef,
        source,
      )
    : null;
  const sourceBinding = returnedSource ?? (await resolveDevelopmentReturnSource(deps, actor, task, proposal, source));
  if (
    !source ||
    !sourceBinding ||
    (actionLeaseCoordinate
      ? !input.predecessorRegistrationId || !returnedSource
      : input.sourceActionRef !== `message:${proposal.sourceMessageId}`)
  )
    throw new Error('Original human source or returned action generation is unavailable');
  const reporterCatIds = returnedSource?.reporterCatIds ?? proposal.preferredCats;
  const id = `development-return-${createHash('sha256')
    .update(
      JSON.stringify([
        actor.userId,
        actor.threadId,
        actor.catId,
        task.id,
        input.predecessorRegistrationId ?? input.expectedRevision,
        child.id,
        input.sourceActionRef,
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
  const registration = developmentReturnRegistrationV1Schema.parse({
    v: 1,
    registrationId: id,
    ownerUserId: actor.userId,
    ownerThreadId: actor.threadId,
    ownerCatId: actor.catId,
    taskRef: `task:work:${task.id}`,
    observedRevision: input.expectedRevision,
    proposalId: proposal.proposalId,
    executionThreadId: child.id,
    reporterCatIds,
    sourceActionRef: input.sourceActionRef,
    ...sourceBinding,
    ...(input.predecessorRegistrationId ? { predecessorRegistrationId: input.predecessorRegistrationId } : {}),
    expectedSignal: 'terminal_report',
    slaUntil: input.slaUntil,
    registeredAt: now,
    status: 'waiting',
  });
  return {
    registration,
    returnStorage: developmentReturnStorage(source, Boolean(returnedSource)),
  };
}

export type DevelopmentReturnFreshnessResolution =
  | { kind: 'current'; revision: number }
  | { kind: 'superseded' }
  | { kind: 'invalid' };

function currentDevelopmentReturnResolution(
  task: CurrentDevelopmentTask,
  report: StoredMessage | null,
  state: Registration,
  child: Thread,
  proposal: ThreadProposal,
  proposalReporter: boolean,
): DevelopmentReturnFreshnessResolution {
  if (!state.report) return { kind: 'current', revision: task.entrustedWork.revision };
  return isCurrentTerminalReport(report, state, child.id, proposal, proposalReporter)
    ? { kind: 'current', revision: task.entrustedWork.revision }
    : { kind: 'invalid' };
}

export async function resolveDevelopmentReturnFreshness(
  deps: AuthorityDeps,
  state: Registration,
): Promise<DevelopmentReturnFreshnessResolution> {
  const [task, owner, child, proposal, report] = await Promise.all([
    deps.tasks.get(state.taskRef.slice('task:work:'.length)),
    deps.threads.get(state.ownerThreadId),
    deps.threads.get(state.executionThreadId),
    deps.proposals.get(state.proposalId),
    state.report ? deps.messages.getById(state.report.sourceMessageId) : null,
  ]);
  const actor = {
    userId: state.ownerUserId,
    threadId: state.ownerThreadId,
    catId: state.ownerCatId,
  };
  if (!owner || owner.deletedAt || owner.createdBy !== state.ownerUserId || !isOpenTaskOwner(task, actor)) {
    return { kind: 'invalid' };
  }
  if (!isApprovedExecution(child, proposal, actor) || !proposal || child.createdFromProposalId !== state.proposalId)
    return { kind: 'invalid' };
  const source = await deps.messages.getById(proposal.sourceMessageId ?? '');
  const actionLeaseCoordinate = parseDevelopmentReturnActionLeaseRef(state.sourceActionRef);
  const returnedStatus = actionLeaseCoordinate
    ? await resolveReturnedActionSuccessorReturnStatus(
        deps,
        actor,
        task,
        proposal,
        child.id,
        state.sourceActionRef,
        source,
        state.reporterCatIds,
      )
    : null;
  if (returnedStatus?.kind === 'superseded') return returnedStatus;
  const returnedSource = returnedStatus?.kind === 'current' ? returnedStatus : null;
  const sourceBinding =
    returnedSource ??
    (state.sourceActionRef === `message:${proposal.sourceMessageId}`
      ? await resolveDevelopmentReturnSource(deps, actor, task, proposal, source)
      : null);
  if (!sameDevelopmentReturnSource(state, sourceBinding)) return { kind: 'invalid' };
  if (returnedSource && JSON.stringify(returnedSource.reporterCatIds) !== JSON.stringify(state.reporterCatIds)) {
    return { kind: 'invalid' };
  }
  return currentDevelopmentReturnResolution(task, report, state, child, proposal, !returnedSource);
}

export async function developmentReturnCurrentRevision(
  deps: AuthorityDeps,
  state: Registration,
): Promise<number | null> {
  const resolution = await resolveDevelopmentReturnFreshness(deps, state);
  return resolution.kind === 'current' ? resolution.revision : null;
}
