/**
 * F128 stale-claim recovery regression tests.
 * Split out to keep proposal-resilience.test.js under the 350-line hard limit (AC-X1).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

async function forceStaleApprovingState(ctx, proposalId, createdThreadId) {
  // Claim the proposal, then reach into the in-memory store to simulate a
  // crash between recordCreatedThread and finalizeApproval.
  const claimed = ctx.proposalStore.claimForApproval({ proposalId, approvedBy: 'alice' });
  assert.ok(claimed);
  const proposal = ctx.proposalStore.proposals.get(proposalId);
  assert.ok(proposal);
  proposal.createdThreadId = createdThreadId;
  proposal.claimedAt = Date.now() - 35_000;
}

async function createDispatchContext() {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const invocationQueue = new InvocationQueue();
  return createProposalTestContext({
    routerOverride: {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
      },
    },
    invocationQueueOverride: invocationQueue,
    queueProcessorOverride: {
      async processNext() {
        return { started: true };
      },
    },
  });
}

function forceApprovedState(ctx, proposalId, createdThreadId) {
  // Simulate an already-approved proposal whose seed may or may not exist.
  const proposal = ctx.proposalStore.proposals.get(proposalId);
  assert.ok(proposal);
  proposal.status = 'approved';
  proposal.approvedBy = 'alice';
  proposal.approvedAt = Date.now();
  proposal.createdThreadId = createdThreadId;
  delete proposal.claimedAt;
}

describe('F128 stale-claim recovery reconciles the child seed', () => {
  test('approve stale recovery finalizes the orphan thread and appends the seed', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Stale approve recovery', reason: 'Crash after thread create' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Stale child');
    await forceStaleApprovingState(ctx, proposalId, child.id);

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.threadId, child.id);
    assert.equal(body.status, 'approved');
    assert.equal(body.recovered, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'stale approve recovery must append the missing seed');
    assert.ok(timeline[0].content.includes('Stale approve recovery'));
  });

  test('reject stale recovery finalizes the orphan thread and appends the seed before refusing reject', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Stale reject recovery', reason: 'Crash after thread create' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Stale child');
    await forceStaleApprovingState(ctx, proposalId, child.id);

    const rejectRes = await ctx.reject('alice', proposalId);
    assert.equal(rejectRes.statusCode, 409);
    const body = JSON.parse(rejectRes.body);
    assert.equal(body.threadId, child.id);
    assert.equal(body.status, 'approved');

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'stale reject recovery must append the missing seed');
    assert.ok(timeline[0].content.includes('Stale reject recovery'));
  });

  test('re-approve uses idempotency key, not any message, when the child already has user chatter', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'User chatter then reconcile', reason: 'Pre-existing child message must not block seed' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const originalAppend = ctx.messageStore.append.bind(ctx.messageStore);
    let childAppendAttempts = 0;
    ctx.messageStore.append = async (input) => {
      if (input.threadId !== source.id) {
        childAppendAttempts += 1;
        if (childAppendAttempts === 1) {
          throw new Error('simulated transient child-seed append failure');
        }
      }
      return originalAppend(input);
    };

    const firstApprove = await ctx.approve('alice', proposalId);
    assert.equal(firstApprove.statusCode, 200);
    const firstBody = JSON.parse(firstApprove.body);
    assert.ok(firstBody.threadId);
    assert.ok(firstBody.warnings?.some((w) => w.includes('initialMessage append failed')));

    // User sends an unrelated message into the child thread before retrying.
    await ctx.messageStore.append({
      userId: 'alice',
      catId: null,
      content: 'User chatter',
      mentions: [],
      timestamp: Date.now(),
      threadId: firstBody.threadId,
    });

    const secondApprove = await ctx.approve('alice', proposalId);
    assert.equal(secondApprove.statusCode, 200);
    const secondBody = JSON.parse(secondApprove.body);
    assert.equal(secondBody.deduped, true);

    const timeline = await ctx.messageStore.getByThread(firstBody.threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 2, 'must reconcile exactly one seed plus one user message');
    assert.ok(timeline.some((m) => m.content.includes('User chatter')));
    assert.ok(timeline.some((m) => m.content.includes('User chatter then reconcile')));

    const thirdApprove = await ctx.approve('alice', proposalId);
    assert.equal(thirdApprove.statusCode, 200);
    const thirdBody = JSON.parse(thirdApprove.body);
    assert.equal(thirdBody.deduped, true);

    const timelineAfterThird = await ctx.messageStore.getByThread(firstBody.threadId, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timelineAfterThird.length, 2, 'third approve must not add another seed');
  });

  test('legacy pre-idempotency seeds are deduped instead of duplicated', async () => {
    const ctx = await createDispatchContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Legacy seed', reason: 'Seed predates idempotency-key index' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Legacy child');
    forceApprovedState(ctx, proposalId, child.id);

    // Seed a legacy child message without the `proposal-initial:<id>` key.
    // It must carry proposal-specific evidence (source cat, source envelope
    // content, crossPost sourceThreadId) to be recognized as the seed.
    const legacySeedContent = '**来源**: Legacy seed\n\nSeed predates idempotency-key index';
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: legacySeedContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id, sourceMessageId: proposal.sourceMessageId } },
    });

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.equal(body.legacySeed, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'must not append a second seed for a legacy pre-index seed');
    assert.equal(timeline[0].content, legacySeedContent);
  });

  test('legacy seed scan reaches beyond the most recent ten messages', async () => {
    const ctx = await createDispatchContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Deep legacy seed', reason: 'Seed is older than the default page size' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Legacy child');
    forceApprovedState(ctx, proposalId, child.id);

    const legacySeedContent = '**来源**: Deep legacy seed\n\nSeed is older than the default page size';
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: legacySeedContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id } },
    });

    // Push the seed outside any fixed "recent N" window.
    for (let i = 0; i < 15; i += 1) {
      await ctx.messageStore.append({
        userId: 'alice',
        catId: null,
        content: `filler message ${i}`,
        mentions: [],
        timestamp: Date.now() + i + 1,
        threadId: child.id,
      });
    }

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.equal(body.legacySeed, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 100, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 16, 'must not append a second seed when the legacy seed is deep in history');
    assert.ok(timeline.some((m) => m.content === legacySeedContent));
  });

  test('ordinary cross-post from source thread is not mistaken for legacy seed', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Cross-post false positive', reason: 'crossPost.sourceThreadId alone must not dedupe' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);
    const proposal = ctx.proposalStore.get(proposalId);
    assert.ok(proposal);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    // An unrelated cross-post that happens to share sourceThreadId but lacks the
    // proposal-specific source envelope content must not block seed reconciliation.
    await ctx.messageStore.append({
      userId: 'alice',
      catId: proposal.sourceCatId,
      content: 'Ordinary cross-post from source thread',
      mentions: [],
      timestamp: Date.now(),
      threadId: child.id,
      extra: { crossPost: { sourceThreadId: source.id } },
    });

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.notEqual(body.legacySeed, true, 'must not treat an ordinary cross-post as the proposal seed');

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 2, 'must append the real seed when the cross-post is not proposal-specific');
    assert.ok(timeline.some((m) => m.content.includes('**来源**: Cross-post false positive')));
    assert.ok(timeline.some((m) => m.content === 'Ordinary cross-post from source thread'));
  });

  test('reconcile skips append when seed-existence reads fail', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Failing dedupe reads', reason: 'Cannot establish seed existence safely' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    const originalGetByIdempotencyKey = ctx.messageStore.getByIdempotencyKey.bind(ctx.messageStore);
    ctx.messageStore.getByIdempotencyKey = async (...args) => {
      if (args[2] === `proposal-initial:${proposalId}`) {
        throw new Error('simulated transient dedupe read failure');
      }
      return originalGetByIdempotencyKey(...args);
    };

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);
    assert.ok(body.warnings?.some((w) => w.includes('cannot verify proposal seed existence')));

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 0, 'must not append a seed when existence cannot be verified safely');
  });

  test('reconcile survives a transient source-thread title lookup failure', async () => {
    const ctx = await createProposalTestContext();
    const source = await ctx.threadStore.create('alice', 'Source');
    const res = await ctx.propose({
      userId: 'alice',
      threadId: source.id,
      body: { title: 'Failing source title lookup', reason: 'Title lookup must be best-effort' },
    });
    assert.equal(res.statusCode, 200);
    const { proposalId } = JSON.parse(res.body);

    const child = await ctx.threadStore.create('alice', 'Child');
    forceApprovedState(ctx, proposalId, child.id);

    const originalGet = ctx.threadStore.get.bind(ctx.threadStore);
    ctx.threadStore.get = async (id) => {
      if (id === source.id) {
        throw new Error('simulated transient source-thread get failure');
      }
      return originalGet(id);
    };

    const approveRes = await ctx.approve('alice', proposalId);
    assert.equal(approveRes.statusCode, 200);
    const body = JSON.parse(approveRes.body);
    assert.equal(body.deduped, true);

    const timeline = await ctx.messageStore.getByThread(child.id, 10, 'alice', {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    });
    assert.equal(timeline.length, 1, 'seed must be reconciled even when source-thread title lookup fails');
    assert.ok(timeline[0].content.includes('Failing source title lookup'));
  });
});
