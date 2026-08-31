// @ts-check
/**
 * F128 / #1406 B1: proposal seed reconcile — exactly-once dispatch.
 *
 * Sol's hard requirement: queue-full, processNext-throw, and processNext
 * started:false must each reconcile on retry, drive the single seed to a
 * terminal delivery state, and never produce duplicate thread messages or
 * duplicate invocations.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createProposalTestContext } from './helpers/proposal-test-harness.js';

const router = {
  async resolveTargetsAndIntent() {
    return { targetCats: ['opus'], intent: { intent: 'execute' }, hasMentions: false };
  },
};

/**
 * Simulate real delivery by mutating the durable message to delivered and
 * dequeuing its queue entry. The production QueueProcessor would do this
 * through transitionQueueCustody; for exactly-once dispatch tests we only
 * care that the seed reaches a terminal state without duplicate wakes.
 *
 * Crucially, we only mark delivered when the message already has queue
 * custody. Part 2's `ensureExistingSeedAdmitted` is what creates that custody
 * for a queue-full seed; without it this helper would be a no-op and the
 * queue-full test would fail with repeated redispatches.
 */
async function simulateDelivery(ctx, invocationQueue, threadId, userId) {
  const entry = invocationQueue.peek(threadId, userId);
  if (entry?.messageId) {
    const msg = await ctx.messageStore.getById(entry.messageId);
    if (msg?.queueCustody) {
      msg.deliveryStatus = 'delivered';
      msg.deliveredAt = Date.now();
    }
    invocationQueue.dequeue(threadId, userId);
  }
  return { started: true };
}

const threadReadOptions = {
  includeQueuedCatMessages: true,
  includeQueuedUserMessages: true,
};

describe('F128 proposal seed reconcile — exactly-once dispatch', () => {
  test('queue-full seed is reconciled once and driven to terminal delivery', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let proposalEnqueueAttempt = 0;
    const originalEnqueue = invocationQueue.enqueue.bind(invocationQueue);
    invocationQueue.enqueue = (input) => {
      if (input.idempotencyKey?.startsWith('proposal-initial:')) {
        proposalEnqueueAttempt += 1;
        if (proposalEnqueueAttempt === 1) {
          return { outcome: 'full' };
        }
      }
      return originalEnqueue(input);
    };

    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('queue is full')));

    const childId = firstBody.threadId;

    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.ok(!secondBody.warnings || secondBody.warnings.length === 0);

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);
    assert.ok(!thirdBody.warnings || thirdBody.warnings.length === 0);

    // Exactly one seed message, one successful processNext, no residual queue entry.
    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must materialize exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'delivered', 'seed must reach terminal delivery');
    assert.equal(processCalls.length, 1, 'must wake the target exactly once');
    assert.equal(invocationQueue.size(childId, 'alice'), 0, 'queue must be empty after delivery');
  });

  test('processNext throw leaves a reconcilable seed with no duplicate invocation', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let shouldThrow = true;
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        if (shouldThrow) {
          throw new Error('simulated processNext failure');
        }
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('auto-start failed')));
    const childId = firstBody.threadId;

    // The seed is materialized and queued, but the queue processor failed to wake.
    const timelineBefore = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timelineBefore.length, 1);
    assert.equal(timelineBefore[0].deliveryStatus, 'queued');
    assert.equal(invocationQueue.size(childId, 'alice'), 1);

    shouldThrow = false;
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'delivered');
    assert.equal(processCalls.length, 2, 'first throw + one successful redispatch');
    assert.equal(invocationQueue.size(childId, 'alice'), 0);
  });

  test('processNext started:false leaves a reconcilable seed with no duplicate invocation', async () => {
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    let shouldStart = false;
    const processCalls = [];
    const queueProcessor = {
      async processNext(threadId, userId) {
        processCalls.push({ threadId, userId });
        if (!shouldStart) {
          return { started: false };
        }
        return simulateDelivery(ctx, invocationQueue, threadId, userId);
      },
    };

    const ctx = await createProposalTestContext({
      routerOverride: router,
      invocationQueueOverride: invocationQueue,
      queueProcessorOverride: queueProcessor,
    });

    const source = await ctx.threadStore.create('alice', 'Source');
    const { proposalId } = JSON.parse(
      (
        await ctx.propose({
          userId: 'alice',
          catId: 'codex',
          threadId: source.id,
          body: { initialMessage: 'Kick this off', preferredCats: ['opus'] },
        })
      ).body,
    );

    const first = await ctx.approve('alice', proposalId);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.ok(firstBody.warnings?.some((w) => w.includes('did not start automatically')));
    const childId = firstBody.threadId;

    shouldStart = true;
    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);

    const third = await ctx.approve('alice', proposalId);
    assert.equal(third.statusCode, 200);
    const thirdBody = JSON.parse(third.body);
    assert.equal(thirdBody.deduped, true);

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'delivered');
    assert.equal(processCalls.length, 2, 'first no-start + one successful redispatch');
    assert.equal(invocationQueue.size(childId, 'alice'), 0);
  });
});
