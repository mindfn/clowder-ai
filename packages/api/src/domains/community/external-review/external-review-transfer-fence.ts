import type { TaskItem, ThreadProposal } from '@cat-cafe/shared';
import { AuthInvocationKeys } from '../../cats/services/agents/invocation/auth-invocation-keys.js';
import { taskAuthorityFence } from '../../cats/services/stores/ports/TaskAuthorityFence.js';
import type { Thread } from '../../cats/services/stores/ports/ThreadStore.js';
import { ProposalKeys } from '../../cats/services/stores/redis-keys/proposals/proposal-keys.js';
import { TaskKeys } from '../../cats/services/stores/redis-keys/task-keys.js';
import { ThreadKeys } from '../../cats/services/stores/redis-keys/thread-keys.js';

export interface ReviewerTransferAuthority {
  threads: readonly Thread[];
  proposal?: ThreadProposal;
  principal: { invocationId: string; catId: string; threadId: string; userId: string };
}
export type TransferCommitResult =
  | 'appended'
  | 'duplicate'
  | 'conflict'
  | 'stale_tracker'
  | 'stale_thread'
  | 'stale_approval'
  | 'stale_invocation';
interface AuthorityReadFence {
  key: string;
  reason: TransferCommitResult;
  fields?: Record<string, string>;
  value?: string;
  absent?: true;
  zeroFields?: string[];
  missingFields?: Record<string, string>;
}

/** Read-only expectations over the EXISTING owners; no duplicated authority record or writer. */
export function reviewerTransferFences(task?: TaskItem, authority?: ReviewerTransferAuthority): AuthorityReadFence[] {
  const fences: AuthorityReadFence[] = [];
  if (task) {
    const fields = taskAuthorityFence(task);
    fences.push(
      { key: TaskKeys.subject(fields.subjectKey), value: task.id, reason: 'stale_tracker' },
      { key: TaskKeys.detail(task.id), fields, reason: 'stale_tracker' },
    );
  }
  if (!authority) return fences;
  for (const thread of new Map(authority.threads.map((t) => [t.id, t])).values()) {
    fences.push(
      {
        key: ThreadKeys.detail(thread.id),
        fields: { id: thread.id, createdBy: thread.createdBy },
        zeroFields: ['deletedAt'],
        reason: 'stale_thread',
      },
      { key: ThreadKeys.tombstone(thread.id), absent: true, reason: 'stale_thread' },
    );
  }
  const proposal = authority.proposal;
  if (proposal) {
    if (!proposal.approvedBy || !proposal.subjectTaskId || !proposal.createdThreadId)
      throw new Error('Approved transfer proposal requires exact authority fields');
    fences.push({
      key: ProposalKeys.detail(proposal.proposalId),
      reason: 'stale_approval',
      fields: {
        proposalId: proposal.proposalId,
        status: proposal.status,
        createdBy: proposal.createdBy,
        approvedBy: proposal.approvedBy,
        subjectTaskId: proposal.subjectTaskId,
        sourceThreadId: proposal.sourceThreadId,
        createdThreadId: proposal.createdThreadId,
        preferredCats: JSON.stringify(proposal.preferredCats),
        createdAt: String(proposal.createdAt),
      },
    });
  }
  const principal = authority.principal;
  fences.push(
    {
      key: AuthInvocationKeys.record(principal.invocationId),
      reason: 'stale_invocation',
      fields: {
        invocationId: principal.invocationId,
        catId: principal.catId,
        threadId: principal.threadId,
        userId: principal.userId,
        state: 'active',
      },
      missingFields: { state: 'active' },
    },
    {
      key: AuthInvocationKeys.latest(principal.threadId, principal.catId),
      value: principal.invocationId,
      reason: 'stale_invocation',
    },
  );
  return fences;
}
