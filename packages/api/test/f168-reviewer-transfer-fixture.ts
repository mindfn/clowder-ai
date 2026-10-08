import type { CommunityEvent, CommunityObjectProjection, TaskItem, ThreadProposal } from '@cat-cafe/shared';
import { taskAuthorityFence } from '../src/domains/cats/services/stores/ports/TaskAuthorityFence.js';
import type { Thread } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { ReviewerTransferAuthority } from '../src/domains/community/external-review/external-review-transfer-fence.js';
export const subjectKey = 'pr:acme/widgets#7';
export const oldReviewer = { catId: 'codex61-sol', threadId: 'thread-old' };
export const newReviewer = { catId: 'codex61-sol', threadId: 'thread-new' };
export function event(kind: string, payload: Record<string, unknown>, sourceEventId = kind): CommunityEvent {
  return { subjectKey, kind, payload, sourceEventId, classification: 'informational', at: 1 } as CommunityEvent;
}

import { CommunityProjector } from '../src/domains/community/community-projector.js';
import { ExternalReviewTransferService } from '../src/domains/community/external-review/ExternalReviewTransferService.js';

export function fixture() {
  const events: CommunityEvent[] = [];
  const values = new Map<string, CommunityObjectProjection>();
  const eventLog = {
    async append(e: CommunityEvent) {
      const existing = events.findIndex((x) => x.sourceEventId === e.sourceEventId);
      if (existing >= 0) return { appended: false, sequence: existing };
      events.push(structuredClone(e));
      return { appended: true, sequence: events.length - 1 };
    },
    async appendIfUnchanged(
      e: CommunityEvent,
      count: number,
      expectedTask?: TaskItem,
      authority?: ReviewerTransferAuthority,
    ) {
      if (events.some((x) => x.sourceEventId === e.sourceEventId)) return 'duplicate' as const;
      if (events.length !== count) return 'conflict' as const;
      if (expectedTask && JSON.stringify(taskAuthorityFence(task)) !== JSON.stringify(taskAuthorityFence(expectedTask)))
        return 'stale_tracker' as const;
      for (const expected of authority?.threads ?? []) {
        const current = threads.get(expected.id);
        if (!current || current.deletedAt || current.createdBy !== expected.createdBy) return 'stale_thread' as const;
      }
      if (
        authority?.proposal &&
        JSON.stringify(proposals.get(authority.proposal.proposalId)) !== JSON.stringify(authority.proposal)
      )
        return 'stale_approval' as const;
      if (authority && !invocation.active) return 'stale_invocation' as const;
      await this.append(e);
      return 'appended' as const;
    },
    async read(key: string) {
      return events.filter((x) => x.subjectKey === key);
    },
    async listSubjects() {
      return [...new Set(events.map((x) => x.subjectKey))];
    },
  };
  const objectStore = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async save(p: CommunityObjectProjection) {
      values.set(p.subjectKey, structuredClone(p));
    },
    async delete(key: string) {
      values.delete(key);
    },
    async listSubjectKeys() {
      return [...values.keys()];
    },
  };
  const projector = new CommunityProjector(eventLog, objectStore);
  const task = {
    id: 'task-7',
    kind: 'pr_tracking',
    subjectKey,
    ownerCatId: newReviewer.catId,
    threadId: newReviewer.threadId,
    userId: 'user-1',
    updatedAt: 1,
  } as TaskItem;
  const threads = new Map(
    [oldReviewer.threadId, newReviewer.threadId].map((id) => [
      id,
      { id, createdBy: 'user-1', deletedAt: null } as Thread,
    ]),
  );
  const proposal = {
    proposalId: 'p-7',
    status: 'approved',
    createdBy: 'user-1',
    approvedBy: 'user-1',
    subjectTaskId: task.id,
    sourceThreadId: oldReviewer.threadId,
    createdThreadId: newReviewer.threadId,
    preferredCats: [newReviewer.catId],
    createdAt: 1,
  } as ThreadProposal;
  const proposals = new Map([[proposal.proposalId, proposal]]);
  const invocation = { active: true };
  const options = {
    isLatestInvocation: async () => true,
    eventLog,
    objectStore,
    projector,
    taskStore: {
      async getBySubject(key: string) {
        return key === subjectKey ? task : null;
      },
    },
    threadStore: {
      async get(id: string) {
        return threads.get(id) ?? null;
      },
    },
    proposalStore: {
      async get(id: string) {
        return proposals.get(id) ?? null;
      },
    },
  };
  const service = new ExternalReviewTransferService(options);
  const input = {
    repoFullName: 'acme/widgets',
    prNumber: 7,
    expectedAssignmentRevision: 0,
    principal: { ...oldReviewer, userId: 'user-1', invocationId: 'inv-1' },
  };
  async function seed() {
    await eventLog.append(
      event('case.external_review_assigned', {
        mode: 'maintainer_review',
        cloudPolicy: 'optional',
        reviewerCatId: oldReviewer.catId,
        reviewerThreadId: oldReviewer.threadId,
      }),
    );
    await eventLog.append(event('case.head_observed', { headSha: 'a'.repeat(40), headGeneration: 1 }));
    await eventLog.append(event('case.ci_observed', { headSha: 'a'.repeat(40), headGeneration: 1, status: 'pass' }));
    await projector.rebuild(subjectKey);
  }
  return {
    events,
    values,
    eventLog,
    objectStore,
    projector,
    task,
    threads,
    proposal,
    proposals,
    invocation,
    options,
    service,
    input,
    seed,
  };
}
