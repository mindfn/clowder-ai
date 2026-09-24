import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

/**
 * F117 KD-21 upgrade window: the previous release wrote turn records without an output fence. The
 * first startup of this release interrupts the ones still running and settles their R. A turn of an
 * action-fenced dispatch must not publish its unjudged draft; an ordinary one keeps its body.
 * Real Redis turn store, real startup reconciler, real settlement.
 */

const REDIS_URL = process.env.REDIS_URL;
const USER = 'user-upgrade';
const THREAD = 'thread-upgrade';

describe(
  'F117 KD-21 upgrade restart over turns the previous release wrote',
  {
    skip: redisIsolationSkipReason(REDIS_URL),
  },
  () => {
    let RedisTurnExecutionStore;
    let MessageStore;
    let DraftStore;
    let InvocationRecordStore;
    let TurnExecutionStartupReconciler;
    let settlement;
    let redis;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'F117 KD-21 legacy output fence startup');
      ({ RedisTurnExecutionStore } = await import(
        '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
      ));
      ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
      ({ DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js'));
      ({ InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'));
      ({ TurnExecutionStartupReconciler } = await import(
        '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
      ));
      settlement = await import('../dist/domains/cats/services/agents/invocation/response-draft-settlement.js');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
      } catch {
        await redis.quit().catch(() => {});
      }
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['turnexec:*']);
      await redis.quit();
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['turnexec:*']);
    });

    /** A turn the previous release left running: its record has no fence, its R is processing. */
    async function previousReleaseTurn({ turns, messages, drafts }, invocationId, parentInvocationId, body) {
      await turns.createRunning({
        invocationId,
        parentInvocationId,
        threadId: THREAD,
        userId: USER,
        catId: 'opus',
        executionKind: 'ordinary',
        startedAt: 10,
      });
      await redis.hdel(`turnexec:record:${invocationId}`, 'outputFence');
      const response = await messages.append({
        from: { kind: 'agent', catId: 'opus' },
        userId: USER,
        content: '',
        mentions: [],
        origin: 'stream',
        timestamp: 10,
        threadId: THREAD,
        idempotencyKey: settlement.lifecycleResponseIdempotencyKey(invocationId),
        lifecycle: {
          kind: 'response',
          orderKey: `10:${invocationId}`,
          invocationId,
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'processing',
          startedAt: 10,
        },
      });
      await drafts.upsert({
        userId: USER,
        threadId: THREAD,
        invocationId,
        catId: 'opus',
        content: body,
        updatedAt: Date.now(),
      });
      return response.id;
    }

    test('a fenced dispatch’s draft stays unpublished and an ordinary one keeps its body', async () => {
      const messages = new MessageStore();
      const drafts = new DraftStore();
      const records = new InvocationRecordStore();
      const queueInvocation = (actionLeaseCarrier) =>
        records.create({
          threadId: THREAD,
          userId: USER,
          targetCats: ['opus'],
          intent: 'execute',
          idempotencyKey: `queue-entry-${actionLeaseCarrier.kind}:opus`,
          actionLeaseCarrier,
        }).invocationId;
      const oldProcess = { turns: new RedisTurnExecutionStore(redis), messages, drafts };
      const fencedResponse = await previousReleaseTurn(
        oldProcess,
        'turn-old-fenced',
        queueInvocation({ kind: 'action_successor', leaseId: 'lease-1', generation: 1 }),
        'HIDDEN_ACTION_OUTPUT',
      );
      const openResponse = await previousReleaseTurn(
        oldProcess,
        'turn-old-open',
        queueInvocation({ kind: 'none' }),
        'the ordinary answer',
      );

      // The upgraded process starts over the same Redis.
      const turns = new RedisTurnExecutionStore(redis);
      const result = await new TurnExecutionStartupReconciler({
        store: turns,
        settleEndedTurnResponse: (turn) =>
          settlement.settleResponseFromDraft(
            { messageStore: messages, draftStore: drafts, turnStore: turns, invocationRecords: records },
            {
              userId: turn.userId,
              threadId: turn.threadId,
              invocationId: turn.invocationId,
              ...settlement.responseOutcomeForEndedTurn(turn),
            },
          ),
      }).reconcile({ processStartedAt: 100 });

      assert.equal(result.interruptedCount, 2);
      assert.equal(result.settledResponseCount, 2);
      assert.deepEqual(result.responseSettlementFailures, []);
      const fenced = await messages.getById(fencedResponse);
      assert.equal(fenced.lifecycle.status, 'interrupted');
      assert.equal(fenced.lifecycle.reason, 'process_restart');
      assert.equal(fenced.content, '', 'an unjudged fenced draft is never published');
      const open = await messages.getById(openResponse);
      assert.equal(open.lifecycle.status, 'interrupted');
      assert.equal(open.content, 'the ordinary answer');
      assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
      assert.deepEqual(await turns.listResponsePending(), []);
    });
  },
);
