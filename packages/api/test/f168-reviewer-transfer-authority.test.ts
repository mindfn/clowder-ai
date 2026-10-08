import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, newReviewer, oldReviewer, subjectKey } from './f168-reviewer-transfer-fixture.js';

function liveThread(f: ReturnType<typeof fixture>, id: string) {
  const thread = f.threads.get(id);
  assert(thread);
  return thread;
}

const mutations = [
  {
    name: 'caller soft deletion',
    code: 'stale_thread',
    mutate: (f: ReturnType<typeof fixture>) => {
      liveThread(f, oldReviewer.threadId).deletedAt = 7;
    },
  },
  {
    name: 'target soft deletion',
    code: 'stale_thread',
    mutate: (f: ReturnType<typeof fixture>) => {
      liveThread(f, newReviewer.threadId).deletedAt = 7;
    },
  },
  {
    name: 'target hard deletion',
    code: 'stale_thread',
    mutate: (f: ReturnType<typeof fixture>) => {
      f.threads.delete(newReviewer.threadId);
    },
  },
  {
    name: 'target ownership change',
    code: 'stale_thread',
    mutate: (f: ReturnType<typeof fixture>) => {
      liveThread(f, newReviewer.threadId).createdBy = 'other-owner';
    },
  },
  {
    name: 'approval deletion',
    code: 'stale_approval',
    approved: true,
    mutate: (f: ReturnType<typeof fixture>) => {
      f.proposals.delete(f.proposal.proposalId);
    },
  },
  {
    name: 'invocation termination',
    code: 'stale_invocation',
    mutate: (f: ReturnType<typeof fixture>) => {
      f.invocation.active = false;
    },
  },
];

for (const { name, code, mutate, approved } of mutations) {
  test(`${name} after validation is fenced at the transfer commit`, async () => {
    const f = fixture();
    await f.seed();
    let checks = 0;
    f.options.isLatestInvocation = async () => {
      if (++checks === 2) mutate(f);
      return true;
    };
    const input = approved
      ? {
          ...f.input,
          proposalId: f.proposal.proposalId,
          principal: { ...f.input.principal, ...newReviewer },
        }
      : f.input;
    await assert.rejects(f.service.transfer(input), { code });
    assert.equal(f.events.filter((e) => e.kind === 'case.external_review_reassigned').length, 0);
    assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, oldReviewer.threadId);
  });
}

test('ordinary activity after validation does not revoke live thread authority', async () => {
  const f = fixture();
  await f.seed();
  let checks = 0;
  f.options.isLatestInvocation = async () => {
    if (++checks === 2) liveThread(f, newReviewer.threadId).title = 'New title';
    return true;
  };
  assert.equal((await f.service.transfer(f.input)).reviewer.threadId, newReviewer.threadId);
});
