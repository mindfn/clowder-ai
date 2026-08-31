// @ts-check
/**
 * F128 / #1406 B1: proposal seed race — orphan carrier rollback.
 *
 * When a concurrent worker completes the seed after this reconcile enqueued a
 * fresh carrier but before the seed could be admitted, executeQueuedDispatch
 * must roll the orphan carrier back.
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

const threadReadOptions = {
  includeQueuedCatMessages: true,
  includeQueuedUserMessages: true,
};

describe('F128 proposal seed race — orphan carrier rollback', () => {
  test('race: concurrent terminal transition after enqueue rolls back orphan carrier', async () => {
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
        return { started: true };
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

    const seed = await ctx.messageStore.getByIdempotencyKey('alice', childId, `proposal-initial:${proposalId}`);
    assert.ok(seed, 'queue-full seed must be materialized with an idempotency key');

    // Simulate another worker completing the seed after this reconcile enqueued a
    // fresh carrier but before the seed could be admitted. The prepareQueueAdmission
    // call sees a terminal seed, ensureExistingSeedAdmitted returns 'complete', and
    // executeQueuedDispatch must roll the orphan carrier back.
    const originalPrepare = ctx.messageStore.prepareQueueAdmission.bind(ctx.messageStore);
    ctx.messageStore.prepareQueueAdmission = async (id) => {
      if (id === seed.id) {
        const msg = await ctx.messageStore.getById(id);
        if (msg && msg.deliveryStatus !== 'delivered' && msg.deliveryStatus !== 'canceled') {
          msg.deliveryStatus = 'delivered';
          msg.deliveredAt = Date.now();
        }
      }
      return originalPrepare(id);
    };

    const second = await ctx.approve('alice', proposalId);
    assert.equal(second.statusCode, 200);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.deduped, true);
    assert.ok(!secondBody.warnings || secondBody.warnings.length === 0);

    const timeline = await ctx.messageStore.getByThread(childId, 10, 'alice', threadReadOptions);
    assert.equal(timeline.length, 1, 'must keep exactly one seed message');
    assert.equal(timeline[0].deliveryStatus, 'delivered');
    assert.equal(processCalls.length, 0, 'seed was already terminal; no wake should happen');
    assert.equal(invocationQueue.size(childId, 'alice'), 0, 'orphan queue carrier must be rolled back');
  });
});
