import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExternalReviewVerdictService } from '../src/domains/community/external-review/ExternalReviewVerdictService.js';
import { event, fixture, newReviewer, subjectKey } from './f168-reviewer-transfer-fixture.js';

async function ready(f: ReturnType<typeof fixture>) {
  await f.seed();
  await f.eventLog.append(event('case.review_ready', { headSha: 'a'.repeat(40), headGeneration: 1 }));
  await f.projector.rebuild(subjectKey);
}

function verdictService(f: ReturnType<typeof fixture>) {
  return new ExternalReviewVerdictService({
    ...f.options,
    repoConfigStore: {
      async getByRepo() {
        return { reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional', updatedAt: 1 };
      },
    },
    fetchCurrentHead: async () => 'a'.repeat(40),
    preflightLease: async () => ({ ok: true, reason: 'active' }),
    completeActionLease: async () => ({ outcome: 'committed' }),
  });
}
const review = {
  repoFullName: 'acme/widgets',
  prNumber: 7,
  reviewedHeadSha: 'a'.repeat(40),
  verdict: 'commented' as const,
  summary: 'Reviewed the exact HEAD.',
  delivery: { kind: 'delivered' as const, githubUrl: 'https://github.com/acme/widgets/pull/7#pullrequestreview-123' },
};

test('new business thread records a real typed verdict; predecessor is rejected', async () => {
  const f = fixture();
  await ready(f);
  await f.service.transfer(f.input);
  const service = verdictService(f);
  await assert.rejects(service.record({ ...review, principal: f.input.principal }), { code: 'wrong_principal' });
  const result = await service.record({ ...review, principal: newReviewer });
  assert.equal(result.delivery.kind, 'delivered');
  assert.equal(f.values.get(subjectKey)?.externalReview?.lastReviewedHeadSha, review.reviewedHeadSha);
});

test('already-authorized predecessor verdict arriving after transfer cannot settle the new assignment', async () => {
  const f = fixture();
  await ready(f);
  const originalAppend = f.eventLog.append.bind(f.eventLog);
  let reached!: () => void;
  let release!: () => void;
  const atAppend = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.eventLog.append = async (event) => {
    if (event.kind === 'case.review_verdict_recorded') {
      reached();
      await delayed;
    }
    return originalAppend(event);
  };
  const old = verdictService(f).record({ ...review, principal: f.input.principal });
  await atAppend;
  await f.service.transfer(f.input);
  release();
  await assert.rejects(old, /not projected|assigned reviewer|assignment/i);
  await f.projector.rebuild(subjectKey);
  assert.equal(f.values.get(subjectKey)?.externalReview?.lastReviewedHeadSha, null);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, newReviewer.threadId);
});

test('verdict committed before transfer returns its successful canonical receipt', async () => {
  const f = fixture();
  await ready(f);
  const apply = f.projector.apply.bind(f.projector);
  f.projector.apply = async (e) => {
    const result = await apply(e);
    if (e.kind === 'case.review_verdict_recorded') await f.service.transfer(f.input);
    return result;
  };
  const result = await verdictService(f).record({ ...review, principal: f.input.principal });
  assert.equal(result.delivery.kind, 'delivered');
  assert.equal(f.values.get(subjectKey)?.externalReview?.lastReviewedHeadSha, review.reviewedHeadSha);
  assert.equal(f.values.get(subjectKey)?.externalReview?.reviewerThreadId, newReviewer.threadId);
});

test('pending intent accepted before transfer has a receipt but never settles in the new assignment', async () => {
  const f = fixture();
  await f.seed();
  await f.eventLog.append(
    event(
      'case.ci_observed',
      {
        headSha: review.reviewedHeadSha,
        headGeneration: 1,
        status: 'pending',
      },
      'ci-pending',
    ),
  );
  await f.projector.rebuild(subjectKey);
  const apply = f.projector.apply.bind(f.projector);
  f.projector.apply = async (e) => {
    const result = await apply(e);
    if (e.kind === 'case.review_verdict_submitted') await f.service.transfer(f.input);
    return result;
  };
  const service = verdictService(f);
  const result = await service.record({ ...review, principal: f.input.principal });
  assert.equal(result.lifecycle, 'pending_verification');
  assert.equal(f.values.get(subjectKey)?.externalReview?.pendingVerdict, null);
  assert.deepEqual(await service.settlePending(subjectKey), { kind: 'none' });
});
