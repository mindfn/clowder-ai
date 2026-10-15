import { type CommunityEvent, prSubjectKey, type TaskItem, type ThreadProposal } from '@cat-cafe/shared';
import type { IProposalStore } from '../../cats/services/stores/ports/ProposalStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import type { ICommunityObjectStore } from '../CommunityObjectStore.js';
import { consumedReviewerGrant } from './external-review-grant-consumption.js';
import type { TransferCommitResult } from './external-review-transfer-fence.js';
import type { ExternalReviewVerdictProjectorPort } from './external-review-verdict-submission.js';

export class ExternalReviewTransferError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface ExternalReviewTransferInput {
  repoFullName: string;
  prNumber: number;
  expectedAssignmentRevision: number;
  proposalId?: string;
  principal: { catId: string; threadId: string; userId: string; invocationId: string };
}
export interface ExternalReviewTransferOptions {
  eventLog: ICommunityEventLog;
  objectStore: Pick<ICommunityObjectStore, 'get'>;
  projector: Pick<ExternalReviewVerdictProjectorPort, 'rebuild'>;
  taskStore: Pick<ITaskStore, 'getBySubject'>;
  threadStore: Pick<IThreadStore, 'get'>;
  proposalStore: Pick<IProposalStore, 'get'>;
  isLatestInvocation: (invocationId: string) => Promise<boolean>;
  now?: () => number;
}

/** Explicit authority handover, never a side effect of a poll or tracker registration. */
export class ExternalReviewTransferService {
  constructor(private readonly opts: ExternalReviewTransferOptions) {}

  async transfer(input: ExternalReviewTransferInput) {
    const append = await this.prepareCommit(input);
    const subjectKey = prSubjectKey(input.repoFullName, input.prNumber);
    const sourceEventId = `f168:reviewer-transfer:${subjectKey}:r${input.expectedAssignmentRevision}`;
    const { task, target, threads } = await this.readTarget(input, subjectKey);
    const events = await this.opts.eventLog.read(subjectKey);
    await this.opts.projector.rebuild(subjectKey);
    const aggregate = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    if (!aggregate)
      throw new ExternalReviewTransferError('missing_assignment', 409, 'Canonical reviewer assignment missing');
    if (aggregate.lifecycle === 'terminal')
      throw new ExternalReviewTransferError('terminal', 409, 'Review subject is terminal');
    if (aggregate.actionLeaseRef)
      throw new ExternalReviewTransferError(
        'lease_transfer_required',
        409,
        'Action lease must be settled through its owner before transfer',
      );

    const prior = events.find((event) => event.sourceEventId === sourceEventId);
    const from =
      prior?.kind === 'case.external_review_reassigned'
        ? (prior.payload.from as { catId: string; threadId: string })
        : { catId: aggregate.reviewerCatId, threadId: aggregate.reviewerThreadId };
    const { authority, proposal } = await this.authorizeTransfer(input, from, target, task);
    if (prior) this.assertRetryAuthority(prior, authority);
    const consumed = proposal ? consumedReviewerGrant(events, proposal.proposalId) : null;
    if (consumed && consumed.sourceEventId !== sourceEventId)
      throw new ExternalReviewTransferError(
        'approval_consumed',
        409,
        'Delegation already authorized a different transfer',
      );

    const revision = aggregate.reviewerAssignmentRevision ?? 0;
    const alreadyTransferred =
      prior?.kind === 'case.external_review_reassigned' &&
      revision === input.expectedAssignmentRevision + 1 &&
      aggregate.reviewerCatId === target.catId &&
      aggregate.reviewerThreadId === target.threadId;
    if (alreadyTransferred)
      return {
        status: 'transferred' as const,
        deduped: true,
        subjectKey,
        reviewer: target,
        assignmentRevision: revision,
      };
    if (revision !== input.expectedAssignmentRevision || prior) {
      throw new ExternalReviewTransferError(
        'stale_assignment',
        409,
        'Reviewer assignment changed; read canonical revision',
      );
    }
    if (from.catId === target.catId && from.threadId === target.threadId) {
      throw new ExternalReviewTransferError('same_assignment', 409, 'Tracker and formal reviewer already agree');
    }
    await this.assertFreshTracker(input, task, subjectKey);
    const event: CommunityEvent = {
      sourceEventId,
      subjectKey,
      kind: 'case.external_review_reassigned',
      classification: 'informational',
      payload: { expectedAssignmentRevision: revision, from, to: target, authority, taskId: task.id },
      at: this.opts.now?.() ?? Date.now(),
    };
    const appended = await append(event, events.length, task, {
      threads,
      proposal,
      principal: input.principal,
    });
    this.assertCommitAccepted(appended);
    if (appended === 'duplicate') {
      const recorded = (await this.opts.eventLog.read(subjectKey)).find((fact) => fact.sourceEventId === sourceEventId);
      if (!recorded) throw new ExternalReviewTransferError('missing_transfer', 503, 'Canonical transfer fact missing');
      this.assertRetryAuthority(recorded, authority);
    }
    // Retry also repairs a crash after append and before projection. No raw projection writes.
    await this.opts.projector.rebuild(subjectKey);
    const applied = (await this.opts.objectStore.get(subjectKey))?.externalReview;
    if (
      applied?.reviewerAssignmentRevision !== revision + 1 ||
      applied.reviewerCatId !== target.catId ||
      applied.reviewerThreadId !== target.threadId
    ) {
      throw new ExternalReviewTransferError(
        'not_applied',
        409,
        'Canonical transfer did not retain the requested target',
      );
    }
    return {
      status: 'transferred' as const,
      deduped: appended === 'duplicate',
      subjectKey,
      reviewer: target,
      assignmentRevision: revision + 1,
    };
  }

  private async prepareCommit(input: ExternalReviewTransferInput) {
    if (!input.principal.invocationId || !(await this.opts.isLatestInvocation(input.principal.invocationId)))
      throw new ExternalReviewTransferError('stale_invocation', 403, 'Current invocation-bound principal required');
    const append = this.opts.eventLog.appendIfUnchanged;
    if (!append)
      throw new ExternalReviewTransferError('unavailable', 503, 'Conditional canonical event producer unavailable');
    if (!Number.isSafeInteger(input.expectedAssignmentRevision) || input.expectedAssignmentRevision < 0)
      throw new ExternalReviewTransferError(
        'invalid_revision',
        400,
        'Expected assignment revision must be nonnegative',
      );
    return append.bind(this.opts.eventLog);
  }

  private async assertFreshTracker(input: ExternalReviewTransferInput, task: TaskItem, subjectKey: string) {
    const current = await this.opts.taskStore.getBySubject(subjectKey);
    if (
      !current ||
      current.id !== task.id ||
      current.updatedAt !== task.updatedAt ||
      current.kind !== task.kind ||
      current.userId !== task.userId ||
      current.threadId !== task.threadId ||
      current.ownerCatId !== task.ownerCatId
    )
      throw new ExternalReviewTransferError('stale_tracker', 409, 'PR tracker changed during transfer');
    if (!(await this.opts.isLatestInvocation(input.principal.invocationId)))
      throw new ExternalReviewTransferError('stale_invocation', 403, 'Invocation changed before transfer commit');
  }

  private assertCommitAccepted(result: TransferCommitResult) {
    if (result === 'appended' || result === 'duplicate') return;
    throw new ExternalReviewTransferError(
      result === 'conflict' ? 'concurrent_event' : result,
      result === 'stale_invocation' ? 403 : 409,
      'Transfer authority or log changed before commit',
    );
  }

  private assertRetryAuthority(event: CommunityEvent, requested: Record<string, unknown>) {
    const recorded = event.payload.authority as Record<string, unknown> | undefined;
    if (
      event.kind !== 'case.external_review_reassigned' ||
      !recorded ||
      recorded.kind !== requested.kind ||
      recorded.proposalId !== requested.proposalId
    )
      throw new ExternalReviewTransferError(
        'retry_authority_mismatch',
        409,
        'Retry must match the original transfer authority',
      );
  }
  private async readTarget(input: ExternalReviewTransferInput, subjectKey: string) {
    const task = structuredClone(await this.opts.taskStore.getBySubject(subjectKey));
    if (
      !task ||
      task.kind !== 'pr_tracking' ||
      task.subjectKey !== subjectKey ||
      !task.ownerCatId ||
      task.userId !== input.principal.userId
    ) {
      throw new ExternalReviewTransferError('wrong_tracker', 403, 'Same-owner canonical PR tracker required');
    }
    const target = { catId: task.ownerCatId, threadId: task.threadId };
    const targetThread = structuredClone(await this.opts.threadStore.get(target.threadId));
    const callerThread = structuredClone(await this.opts.threadStore.get(input.principal.threadId));
    if (
      !targetThread ||
      targetThread.deletedAt ||
      targetThread.createdBy !== input.principal.userId ||
      !callerThread ||
      callerThread.deletedAt ||
      callerThread.createdBy !== input.principal.userId
    ) {
      throw new ExternalReviewTransferError('wrong_thread', 403, 'Live same-owner caller and target threads required');
    }
    return { task, target, threads: [targetThread, callerThread] };
  }

  private async authorizeTransfer(
    input: ExternalReviewTransferInput,
    from: { catId: string | null; threadId: string | null },
    target: { catId: NonNullable<TaskItem['ownerCatId']>; threadId: string },
    task: TaskItem,
  ) {
    const assignedCaller = from?.catId === input.principal.catId && from?.threadId === input.principal.threadId;
    let authority: Record<string, unknown>;
    let approvedProposal: ThreadProposal | undefined;
    if (input.proposalId) {
      const proposal = structuredClone(await this.opts.proposalStore.get(input.proposalId));
      if (
        !proposal ||
        proposal.status !== 'approved' ||
        proposal.createdBy !== input.principal.userId ||
        proposal.approvedBy !== input.principal.userId ||
        proposal.subjectTaskId !== task.id ||
        proposal.sourceThreadId !== from?.threadId ||
        proposal.createdThreadId !== target.threadId ||
        !proposal.preferredCats.includes(target.catId) ||
        input.principal.catId !== target.catId ||
        input.principal.threadId !== target.threadId
      ) {
        throw new ExternalReviewTransferError(
          'wrong_approval',
          403,
          'Approved delegation must bind this Task, source and exact target principal',
        );
      }
      authority = { kind: 'approved_proposal', proposalId: proposal.proposalId, userId: input.principal.userId };
      approvedProposal = proposal;
    } else {
      if (!assignedCaller)
        throw new ExternalReviewTransferError(
          'wrong_principal',
          403,
          'Only the assigned reviewer may hand over without approved delegation',
        );
      authority = { kind: 'assigned_reviewer', userId: input.principal.userId };
    }

    return { authority, proposal: approvedProposal };
  }
}
