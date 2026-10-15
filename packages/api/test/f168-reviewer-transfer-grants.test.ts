import assert from 'node:assert/strict';
import { test } from 'node:test';
import { event, fixture, newReviewer, oldReviewer, subjectKey } from './f168-reviewer-transfer-fixture.js';

function delegated(f: ReturnType<typeof fixture>, revision: number, proposalId = f.proposal.proposalId) {
  return {
    ...f.input,
    expectedAssignmentRevision: revision,
    proposalId,
    principal: { ...f.input.principal, ...newReviewer },
  };
}

test('spent delegation cannot restore its target with a fresh revision after ABA', async () => {
  const f = fixture();
  await f.seed();
  await f.service.transfer(delegated(f, 0));
  assert.equal((await f.service.transfer(delegated(f, 0))).deduped, true);
  f.task.threadId = oldReviewer.threadId;
  f.task.updatedAt++;
  await f.service.transfer({
    ...f.input,
    expectedAssignmentRevision: 1,
    principal: { ...f.input.principal, ...newReviewer },
  });
  f.task.threadId = newReviewer.threadId;
  f.task.updatedAt++;
  await assert.rejects(f.service.transfer(delegated(f, 2)), { code: 'approval_consumed' });
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, oldReviewer.threadId);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerAssignmentRevision, 2);
  await f.eventLog.append(
    event(
      'case.external_review_reassigned',
      {
        expectedAssignmentRevision: 2,
        from: oldReviewer,
        to: newReviewer,
        authority: { kind: 'approved_proposal', proposalId: f.proposal.proposalId },
      },
      'spent-grant-replay',
    ),
  );
  await f.projector.rebuild(subjectKey);
  assert.equal(
    f.values.get(subjectKey)?.externalReview?.reviewerThreadId,
    oldReviewer.threadId,
    'canonical replay also rejects a spent grant',
  );
  // A genuinely separate approval can still authorize the new handover.
  const fresh = { ...f.proposal, proposalId: 'p-new', createdAt: f.proposal.createdAt + 1 };
  f.proposals.set(fresh.proposalId, fresh);
  assert.equal((await f.service.transfer(delegated(f, 2, fresh.proposalId))).assignmentRevision, 3);
});

test('recorded but rejected transfer does not consume an approved delegation', async () => {
  const f = fixture();
  await f.seed();
  await f.eventLog.append(
    event(
      'case.external_review_reassigned',
      {
        expectedAssignmentRevision: 99,
        from: oldReviewer,
        to: newReviewer,
        authority: { kind: 'approved_proposal', proposalId: f.proposal.proposalId },
      },
      'rejected-grant-transfer',
    ),
  );
  assert.equal((await f.service.transfer(delegated(f, 0))).assignmentRevision, 1);
});

test('crash after a grant-consuming append allows exact recovery without a second consumption', async () => {
  const f = fixture();
  await f.seed();
  const rebuild = f.projector.rebuild.bind(f.projector);
  f.projector.rebuild = async (key) => {
    if (f.events.some((e) => e.kind === 'case.external_review_reassigned')) throw new Error('projection crash');
    return rebuild(key);
  };
  await assert.rejects(f.service.transfer(delegated(f, 0)), /projection crash/);
  f.projector.rebuild = rebuild;
  assert.equal((await f.service.transfer(delegated(f, 0))).deduped, true);
  assert.equal(f.events.filter((e) => e.kind === 'case.external_review_reassigned').length, 1);
});

test('a different authority cannot impersonate an original or concurrent retry', async () => {
  const f = fixture();
  await f.seed();
  const append = f.eventLog.appendIfUnchanged.bind(f.eventLog);
  let first = true;
  f.eventLog.appendIfUnchanged = async (...args) => {
    if (first) {
      first = false;
      await f.service.transfer(f.input);
    }
    return append(...args);
  };
  await assert.rejects(f.service.transfer(delegated(f, 0)), { code: 'retry_authority_mismatch' });
  await assert.rejects(f.service.transfer(delegated(f, 0)), { code: 'retry_authority_mismatch' });
  assert.equal(f.events.filter((e) => e.kind === 'case.external_review_reassigned').length, 1);
  assert.equal(f.values.get(subjectKey)?.externalReview?.consumedDelegations, undefined);
});
