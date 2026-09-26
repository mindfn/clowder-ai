// F117 Phase M: an Append handed to a running carrier waits on its dispatchRef (canonical) with a
// handed index on the response; consumption evidence makes it read; a response that settles first
// leaves it unread and publishes it. Runs on the in-memory store, and on Redis when an isolated
// REDIS_URL is given.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { isLifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const THREAD = 'thread-phase-m';
let seq = 0;

async function seed(store) {
  seq += 1;
  const input = await store.append(
    canonicalTestMessageInput({
      userId: 'owner-1',
      threadId: THREAD,
      catId: null,
      content: `append me ${seq}`,
      mentions: ['opus'],
      timestamp: 90,
      deliveryStatus: 'queued',
    }),
  );
  const invocationId = `turn-opus-${seq}`;
  const response = await store.append(
    canonicalTestMessageInput({
      userId: 'owner-1',
      threadId: THREAD,
      catId: 'opus',
      content: '',
      mentions: [],
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: `100:${invocationId}`,
        from: { kind: 'agent', catId: 'opus' },
        invocationId,
        targetId: 'opus',
        inputEntryIds: ['entry-first'],
        inputMessageIds: ['message-first'],
        status: 'processing',
        startedAt: 100,
      },
    }),
  );
  const run = { targetId: 'opus', invocationId, responseMessageId: response.id };
  const hand = {
    threadId: THREAD,
    entryId: `entry-append-${seq}`,
    inputMessageIds: [input.id],
    handed: true,
    runs: [{ ...run, dispatchedAt: 110 }],
  };
  const read = (readAt) => ({
    threadId: THREAD,
    entryId: hand.entryId,
    inputMessageIds: [input.id],
    run,
    readAt,
  });
  return { input, response, run, hand, read };
}

async function settle(store, responseId, invocationId) {
  const { settleLifecycleResponseInputs } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const terminal = await store.commitLifecycleResponseTerminal(responseId, {
    invocationId,
    status: 'completed',
    completedAt: 200,
    content: 'final body',
    contentBlocks: [{ type: 'text', text: 'final body' }],
    mentions: [],
    origin: 'stream',
  });
  assert.equal(terminal.kind, 'applied');
  await settleLifecycleResponseInputs(store, terminal.message, responseId);
}

function phaseMScenarios(label, getStore) {
  describe(`F117 Phase M lifecycle read (${label})`, () => {
    test('a handed Append waits on its ref and is read only by the read commit', async () => {
      const store = getStore();
      const { input, response, hand, read } = await seed(store);

      assert.equal((await store.commitLifecycleAppendAdmission(hand)).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        {
          targetId: 'opus',
          phase: 'dispatched',
          statusMessageId: response.id,
          dispatchedAt: 110,
          readState: 'awaiting',
        },
      ]);
      let r = (await store.getById(response.id)).lifecycle;
      assert.deepEqual(r.inputMessageIds, ['message-first'], 'a handed Append is not one of the inputs');
      assert.deepEqual(r.handedInputEntryIds, [hand.entryId]);
      assert.deepEqual(r.handedInputMessageIds, [input.id]);
      assert.equal(r.latestInputTimelineOrderAt, undefined);
      assert.equal((await store.getById(input.id)).deliveryStatus, 'queued', 'not published before it is read');
      assert.equal((await store.commitLifecycleAppendAdmission(hand)).kind, 'replayed');

      assert.equal((await store.commitLifecycleAppendRead(read(130))).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'dispatched', statusMessageId: response.id, dispatchedAt: 110, readAt: 130 },
      ]);
      r = (await store.getById(response.id)).lifecycle;
      assert.deepEqual(r.inputEntryIds, ['entry-first', hand.entryId]);
      assert.deepEqual(r.inputMessageIds, ['message-first', input.id]);
      assert.equal(r.handedInputEntryIds, undefined);
      assert.equal(r.handedInputMessageIds, undefined);
      assert.equal(r.latestInputTimelineOrderAt, 130);
      assert.equal((await store.commitLifecycleAppendRead(read(140))).kind, 'replayed');

      await settle(store, response.id, r.invocationId);
      const settled = await store.getById(input.id);
      assert.deepEqual(settled.lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: response.id, dispatchedAt: 110, readAt: 130 },
      ]);
      assert.equal(settled.deliveryStatus, 'delivered', 'the terminal publishes a read Append left queued');
      assert.equal(settled.deliveredAt, 130);
    });

    test('a response that settles first leaves the Append unread, published, and upgradable by late evidence', async () => {
      const store = getStore();
      const { input, response, run, hand, read } = await seed(store);
      assert.equal((await store.commitLifecycleAppendAdmission(hand)).kind, 'applied');

      await settle(store, response.id, run.invocationId);
      const unread = await store.getById(input.id);
      assert.deepEqual(unread.lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: response.id, dispatchedAt: 110, readState: 'unread' },
      ]);
      assert.equal(unread.deliveryStatus, 'delivered', 'no queued source without a ledger row after the terminal');
      assert.equal(unread.deliveredAt, 200);
      const r = (await store.getById(response.id)).lifecycle;
      assert.deepEqual(r.handedInputMessageIds, [input.id], 'the terminal response still indexes what it never read');
      assert.deepEqual(r.inputMessageIds, ['message-first']);

      assert.equal((await store.commitLifecycleAppendRead(read(190))).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: response.id, dispatchedAt: 110, readAt: 190 },
      ]);
      assert.deepEqual((await store.getById(response.id)).lifecycle.inputMessageIds, ['message-first', input.id]);
    });

    test('a rejected handed Append settles to its failure and leaves the handed index', async () => {
      const store = getStore();
      const { input, response, run, hand } = await seed(store);
      assert.equal((await store.commitLifecycleAppendAdmission(hand)).kind, 'applied');
      const failure = await store.append(
        canonicalTestMessageInput({
          userId: 'owner-1',
          threadId: THREAD,
          catId: null,
          content: 'carrier closed',
          mentions: [],
          timestamp: 115,
          lifecycle: {
            kind: 'delivery_failure',
            orderKey: `115:failure-${seq}`,
            from: { kind: 'system', service: 'message_delivery' },
            status: 'failed',
            sourceEntryId: hand.entryId,
            inputMessageId: input.id,
            requestedTargets: ['opus'],
            reason: 'control_carrier_replaced',
            createdAt: 115,
          },
        }),
      );
      const rejection = {
        threadId: THREAD,
        entryId: hand.entryId,
        inputMessageIds: [input.id],
        failureMessageIds: [failure.id],
        run,
      };
      assert.equal((await store.commitLifecycleAppendRejection(rejection)).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: failure.id, dispatchedAt: 110 },
      ]);
      const r = (await store.getById(response.id)).lifecycle;
      assert.equal(r.handedInputMessageIds, undefined);
      assert.deepEqual(r.inputMessageIds, ['message-first']);
      assert.equal((await store.commitLifecycleAppendRejection(rejection)).kind, 'replayed');
    });

    test('nothing is handed to a response that already ended', async () => {
      const store = getStore();
      const { response, run, hand } = await seed(store);
      await settle(store, response.id, run.invocationId);
      assert.deepEqual(await store.commitLifecycleAppendAdmission(hand), {
        kind: 'conflict',
        reason: 'response_lifecycle_conflict',
      });
    });
  });
}

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const memoryStore = new MessageStore();
phaseMScenarios('memory', () => memoryStore);

const REDIS_URL = process.env.REDIS_URL;
describe('F117 Phase M lifecycle read on Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F117 Phase M lifecycle read on Redis');
    const [{ createRedisClient }, { RedisMessageStore }] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
    ]);
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    store = new RedisMessageStore(redis, { ttlSeconds: 0 });
  });
  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    await redis.quit();
  });
  phaseMScenarios('redis', () => store);
});

describe('F117 Phase M lifecycle read markers are fail-closed', () => {
  const input = (ref) => ({ kind: 'input', orderKey: '1:m', dispatchRefs: [ref] });
  const base = { targetId: 'opus', statusMessageId: 'r-1', dispatchedAt: 1 };
  test('accepts only a waiting dispatched ref, an unread settled ref, or a read time alone', () => {
    assert.equal(
      isLifecycleStoredMessageMetadata(input({ ...base, phase: 'dispatched', readState: 'awaiting' })),
      true,
    );
    assert.equal(isLifecycleStoredMessageMetadata(input({ ...base, phase: 'settled', readState: 'unread' })), true);
    assert.equal(isLifecycleStoredMessageMetadata(input({ ...base, phase: 'settled', readAt: 5 })), true);
    assert.equal(isLifecycleStoredMessageMetadata(input({ ...base, phase: 'dispatched', readState: 'unread' })), false);
    assert.equal(isLifecycleStoredMessageMetadata(input({ ...base, phase: 'settled', readState: 'awaiting' })), false);
    assert.equal(
      isLifecycleStoredMessageMetadata(input({ ...base, phase: 'dispatched', readState: 'awaiting', readAt: 5 })),
      false,
    );
    assert.equal(isLifecycleStoredMessageMetadata(input({ ...base, phase: 'dispatched', readAt: -1 })), false);
  });
  test('requires the handed index to be message identities', () => {
    const response = (handed) => ({
      kind: 'response',
      orderKey: '1:r',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      handedInputEntryIds: ['entry-1'],
      handedInputMessageIds: handed,
      status: 'processing',
      startedAt: 1,
    });
    assert.equal(isLifecycleStoredMessageMetadata(response(['m-1'])), true);
    assert.equal(isLifecycleStoredMessageMetadata(response([''])), false);
    assert.equal(isLifecycleStoredMessageMetadata(response('m-1')), false);
  });
});
