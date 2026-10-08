import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExternalReviewCoordinator } from '../src/domains/community/external-review/ExternalReviewCoordinator.js';
import { ExternalReviewTransferService } from '../src/domains/community/external-review/ExternalReviewTransferService.js';
import { applyExternalReviewProjectionEvent } from '../src/domains/community/external-review/external-review-projector.js';
import { event, fixture, newReviewer, oldReviewer, subjectKey } from './f168-reviewer-transfer-fixture.js';

const initial = applyExternalReviewProjectionEvent(
  null,
  event('case.external_review_assigned', {
    mode: 'maintainer_review',
    cloudPolicy: 'optional',
    reviewerCatId: oldReviewer.catId,
    reviewerThreadId: oldReviewer.threadId,
  }),
);
assert(initial.ok);

test('explicit transfer moves only the reviewer and invalidates predecessor submission/wake', () => {
  const result = applyExternalReviewProjectionEvent(
    initial.value,
    event('case.external_review_reassigned', {
      expectedAssignmentRevision: 0,
      from: oldReviewer,
      to: newReviewer,
      authority: { kind: 'assigned_reviewer', userId: 'user-1', invocationId: 'inv-1' },
      taskId: 'task-7',
    }),
  );
  assert(result.ok, 'the canonical reassignment producer must be accepted');
  assert.equal(result.value.reviewerThreadId, newReviewer.threadId);
  assert.equal(result.value.reviewerAssignmentRevision, 1);
  assert.equal(result.value.verdictSubmissionEpoch, 1);
});

test('current assigned reviewer transfers to admitted tracker; replay/restart and retry retain exact history', async () => {
  const f = fixture();
  await f.seed();
  const before = structuredClone(f.values.get(subjectKey)?.externalReview);
  assert(before);
  const receipt = await f.service.transfer(f.input);
  assert.equal(receipt.reviewer.threadId, newReviewer.threadId);
  assert.equal(receipt.assignmentRevision, 1);
  const after = f.values.get(subjectKey);
  assert(after);
  assert.equal(after.ownerThreadId, newReviewer.threadId);
  assert.deepEqual(after.externalReview?.ci, before.ci);
  assert.equal(after.externalReview?.currentHeadSha, before.currentHeadSha);
  assert.equal(after.externalReview?.headGeneration, before.headGeneration);
  const retry = await new ExternalReviewTransferService(f.options).transfer(f.input);
  assert.equal(retry.deduped, true);
  assert.equal(f.events.filter((x) => x.kind === 'case.external_review_reassigned').length, 1);
  await f.projector.rebuild(subjectKey);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, newReviewer.threadId);
});

test('target can consume exactly its approved Task-bound delegation', async () => {
  const f = fixture();
  await f.seed();
  const receipt = await f.service.transfer({
    ...f.input,
    proposalId: 'p-7',
    principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' },
  });
  assert.equal(receipt.assignmentRevision, 1);
  assert.equal(
    (
      await f.service.transfer({
        ...f.input,
        proposalId: 'p-7',
        principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' },
      })
    ).deduped,
    true,
  );
});

for (const [name, change, code] of [
  [
    'unapproved',
    (f: ReturnType<typeof fixture>) => {
      f.proposal.status = 'pending';
    },
    'wrong_approval',
  ],
  [
    'other Task',
    (f: ReturnType<typeof fixture>) => {
      f.proposal.subjectTaskId = 'other-task';
    },
    'wrong_approval',
  ],
  [
    'other source',
    (f: ReturnType<typeof fixture>) => {
      f.proposal.sourceThreadId = 'other-thread';
    },
    'wrong_approval',
  ],
  [
    'other tenant',
    (f: ReturnType<typeof fixture>) => {
      f.task.userId = 'other-user';
    },
    'wrong_tracker',
  ],
  [
    'generic Task',
    (f: ReturnType<typeof fixture>) => {
      f.task.kind = 'work';
    },
    'wrong_tracker',
  ],
  [
    'deleted target',
    (f: ReturnType<typeof fixture>) => {
      const thread = f.threads.get(newReviewer.threadId);
      assert(thread);
      thread.deletedAt = 2;
    },
    'wrong_thread',
  ],
  [
    'foreign target',
    (f: ReturnType<typeof fixture>) => {
      const thread = f.threads.get(newReviewer.threadId);
      assert(thread);
      thread.createdBy = 'other-user';
    },
    'wrong_thread',
  ],
] as const) {
  test(`target transfer rejects ${name} without appending authority`, async () => {
    const f = fixture();
    await f.seed();
    change(f);
    await assert.rejects(
      f.service.transfer({
        ...f.input,
        proposalId: 'p-7',
        principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' },
      }),
      { code },
    );
    assert.equal(f.events.length, 3);
  });
}

test('unassigned target cannot grant itself rights from tracker alone', async () => {
  const f = fixture();
  await f.seed();
  await assert.rejects(
    f.service.transfer({ ...f.input, principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' } }),
    {
      code: 'wrong_principal',
    },
  );
  assert.equal(f.events.length, 3);
});

test('terminal and active-lease assignments cannot be transferred', async () => {
  for (const lease of [false, true]) {
    const f = fixture();
    await f.seed();
    // Exercise canonical replay with the terminal/lease fact, not only a cached projection.
    if (lease)
      await f.eventLog.append(
        event(
          'case.external_review_assigned',
          {
            mode: 'maintainer_review',
            cloudPolicy: 'optional',
            reviewerCatId: oldReviewer.catId,
            reviewerThreadId: oldReviewer.threadId,
            actionLeaseRef: { leaseId: 'lease', generation: 1 },
          },
          'lease-assignment',
        ),
      );
    else await f.eventLog.append({ ...event('pr.closed', {}), classification: 'state-changing' });
    await assert.rejects(f.service.transfer(f.input), { code: lease ? 'lease_transfer_required' : 'terminal' });
    assert.equal(f.events.filter((x) => x.kind === 'case.external_review_reassigned').length, 0);
  }
});

test('A→B→A is legal with fresh custody, but old handover cannot replay after ABA', async () => {
  const f = fixture();
  await f.seed();
  await f.service.transfer(f.input);
  f.task.threadId = oldReviewer.threadId;
  f.task.updatedAt = 2;
  await f.service.transfer({
    ...f.input,
    expectedAssignmentRevision: 1,
    principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' },
  });
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerAssignmentRevision, 2);
  await assert.rejects(f.service.transfer(f.input), { code: 'stale_assignment' });
  await f.projector.rebuild(subjectKey);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, oldReviewer.threadId);
});

test('delayed predecessor poll and policy refresh cannot reclaim a transferred reviewer', async () => {
  const f = fixture();
  await f.seed();
  await f.service.transfer(f.input);
  const coordinator = new ExternalReviewCoordinator({
    ...f.options,
    repoConfigStore: {
      async getByRepo() {
        return { reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional', updatedAt: 2 };
      },
    },
    log: { info() {}, warn() {}, error() {} },
  });
  await coordinator.recordCi(
    { repoFullName: 'acme/widgets', prNumber: 7, headSha: 'a'.repeat(40), aggregateBucket: 'pass' } as Parameters<
      typeof coordinator.recordCi
    >[0],
    { ...oldReviewer, userId: 'user-1', invocationId: 'inv-1' },
  );
  await f.eventLog.append(
    event(
      'case.external_review_assigned',
      {
        mode: 'maintainer_review',
        cloudPolicy: 'optional',
        reviewerCatId: oldReviewer.catId,
        reviewerThreadId: oldReviewer.threadId,
      },
      'old-unfenced-assignment',
    ),
  );
  await f.projector.rebuild(subjectKey);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, newReviewer.threadId);
});

test('simultaneous identical transfer is idempotent across separate service instances', async () => {
  const f = fixture();
  await f.seed();
  const results = await Promise.allSettled([
    f.service.transfer(f.input),
    new ExternalReviewTransferService(f.options).transfer(f.input),
  ]);
  assert(results.some((r) => r.status === 'fulfilled'));
  assert.equal(f.events.filter((x) => x.kind === 'case.external_review_reassigned').length, 1);
  await f.projector.rebuild(subjectKey);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerAssignmentRevision, 1);
});

test('crash after durable append recovers same transfer on retry', async () => {
  const f = fixture();
  await f.seed();
  const original = f.projector.rebuild.bind(f.projector);
  f.projector.rebuild = async (key: string) => {
    if (f.events.some((x) => x.kind === 'case.external_review_reassigned')) throw new Error('projection failed');
    return original(key);
  };
  await assert.rejects(f.service.transfer(f.input), /projection failed/);
  f.projector.rebuild = original;
  assert.equal((await f.service.transfer(f.input)).deduped, true);
  assert.equal(f.events.filter((x) => x.kind === 'case.external_review_reassigned').length, 1);
});

test('concurrent canonical event and stale tracker reject before assignment append', async () => {
  const f = fixture();
  await f.seed();
  f.eventLog.appendIfUnchanged = async () => 'conflict';
  await assert.rejects(f.service.transfer(f.input), { code: 'concurrent_event' });
  assert.equal(f.events.length, 3);
});

test('stale invocation and changed tracker fail before commit', async () => {
  const f = fixture();
  await f.seed();
  f.options.isLatestInvocation = async () => false;
  await assert.rejects(f.service.transfer(f.input), { code: 'stale_invocation' });
  f.options.isLatestInvocation = async () => true;
  let reads = 0;
  f.options.taskStore.getBySubject = async () => {
    reads++;
    if (reads === 2) f.task.updatedAt++;
    return { ...f.task };
  };
  await assert.rejects(f.service.transfer(f.input), { code: 'stale_tracker' });
  assert.equal(f.events.length, 3);
});

test('tracker moving after the last read is fenced in the event commit', async () => {
  const f = fixture();
  await f.seed();
  let invocationChecks = 0;
  f.options.isLatestInvocation = async () => {
    if (++invocationChecks === 2) f.task.threadId = 'thread-third';
    return true;
  };
  await assert.rejects(f.service.transfer(f.input), { code: 'stale_tracker' });
  assert.equal(f.events.filter((e) => e.kind === 'case.external_review_reassigned').length, 0);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, oldReviewer.threadId);
});

test('unrelated PR and stale approval cannot consume this transfer', async () => {
  const f = fixture();
  await f.seed();
  await assert.rejects(f.service.transfer({ ...f.input, prNumber: 8 }), { code: 'wrong_tracker' });
  f.proposal.approvedBy = 'other-owner';
  await assert.rejects(
    f.service.transfer({
      ...f.input,
      proposalId: 'p-7',
      principal: { ...newReviewer, userId: 'user-1', invocationId: 'inv-1' },
    }),
    { code: 'wrong_approval' },
  );
  assert.equal(f.events.length, 3);
});

test('foreign-tenant request cannot even rebuild the victim projection', async () => {
  const f = fixture();
  await f.seed();
  let rebuilt = false;
  f.projector.rebuild = async () => {
    rebuilt = true;
  };
  await assert.rejects(f.service.transfer({ ...f.input, principal: { ...f.input.principal, userId: 'other-user' } }), {
    code: 'wrong_tracker',
  });
  assert.equal(rebuilt, false);
});
