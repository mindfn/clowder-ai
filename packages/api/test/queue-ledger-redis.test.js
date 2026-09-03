import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('ADR-043 Redis queue ledger', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let messageStore;
  let InvocationQueue;
  let queueEntryId;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'ADR-043 Redis queue ledger');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const module = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js'
    );
    ({ queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js'));
    ({ InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'));
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    store = new module.RedisQueueLedgerStore(redis);
    messageStore = new RedisMessageStore(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*']);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*']);
  });

  function row(sourceId, targetCatId, overrides = {}) {
    return {
      version: 1,
      id: queueEntryId(sourceId, targetCatId),
      threadId: 'thread-redis',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      target: { kind: 'cat', catId: targetCatId },
      payload: { sourceId, content: sourceId, messageId: sourceId },
      execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
      delivery: {},
      status: 'queued',
      enqueuedAt: 100,
      priority: 'normal',
      ...overrides,
    };
  }

  it('round-trips fan-out rows in stable order and rejects conflicting replay', async () => {
    const rows = [row('m1', 'opus'), row('m1', 'codex')];
    assert.equal((await store.enqueue(rows, 5)).outcome, 'enqueued');
    assert.equal((await store.enqueue(rows, 5)).outcome, 'replayed');
    assert.equal((await store.enqueue([{ ...rows[0], priority: 'urgent' }, rows[1]], 5)).outcome, 'conflict');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.target.catId),
      ['opus', 'codex'],
    );
    assert.deepEqual((await store.getByMessageIds('thread-redis', ['m1', 'missing'])).get('m1'), rows);
  });

  it('claims and restores without changing Redis list order', async () => {
    const first = row('m1', 'opus');
    const second = row('m2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    assert.equal((await store.claim('thread-redis', first.id, 'claim-1', 200)).outcome, 'claimed');
    assert.equal((await store.restore('thread-redis', first.id, 'stale')).outcome, 'state_changed');
    assert.equal((await store.restore('thread-redis', first.id, 'claim-1')).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.id),
      [first.id, second.id],
    );
  });

  it('binds a targetless row in the same atomic claim', async () => {
    const targetless = row('m1', 'placeholder', {
      id: queueEntryId('m1'),
      target: { kind: 'unassigned' },
    });
    await store.enqueue([targetless]);
    const claimed = await store.claim('thread-redis', targetless.id, 'claim-targetless', 200, 'codex', 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].target, { kind: 'cat', catId: 'codex' });
    assert.equal(claimed.entries[0].delivery.steerRequestedAt, 199);
    const restored = await store.restore('thread-redis', targetless.id, 'claim-targetless', true);
    assert.equal(restored.outcome, 'updated');
    assert.equal(restored.entry.delivery.steerRequestedAt, undefined);
    assert.deepEqual(restored.entry.target, { kind: 'unassigned' });
  });

  it('claims prefixes all-or-nothing and retains terminal idempotency tombstones outside active order', async () => {
    const first = row('m1', 'opus');
    const second = row('m2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    const claimed = await store.claimPrefix('thread-redis', [first.id, second.id], 'batch-1', 200, undefined, 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.ok(claimed.entries.every((entry) => entry.delivery.steerRequestedAt === 199));
    assert.equal((await store.commit('thread-redis', first.id, 'batch-1', 'processing', 201)).outcome, 'updated');
    assert.equal((await store.commit('thread-redis', first.id, '', 'terminal', 300)).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => [entry.id, entry.status]),
      [[second.id, 'claimed']],
    );
    assert.equal((await store.get('thread-redis', first.id)).status, 'terminal');
    const replay = await store.enqueue([{ ...first, enqueuedAt: 999 }]);
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.entries[0].status, 'terminal');
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.id),
      [second.id],
    );
  });

  it('atomically persists terminal delivery evidence outside active order', async () => {
    const entry = row('m-terminal', 'opus');
    await store.enqueue([entry]);
    await store.claim('thread-redis', entry.id, 'claim-terminal', 200);
    const processing = await store.commit('thread-redis', entry.id, 'claim-terminal', 'processing', 201);
    assert.equal(processing.outcome, 'updated');

    const terminal = await store.commit('thread-redis', entry.id, '', 'terminal', 300, {
      ...processing.entry,
      delivery: {
        ...processing.entry.delivery,
        terminalOutcome: 'interrupted',
        failedAt: 300,
        failureReason: 'runtime_restart',
      },
    });
    assert.equal(terminal.outcome, 'updated');
    assert.deepEqual(await store.list('thread-redis'), []);
    assert.deepEqual(await store.listAll('thread-redis'), [terminal.entry]);
    assert.deepEqual((await store.getByMessageIds('thread-redis', ['m-terminal'])).get('m-terminal'), [terminal.entry]);
    assert.equal((await store.get('thread-redis', entry.id)).delivery.terminalOutcome, 'interrupted');
  });

  it('updates processing receipt evidence without changing execution ownership', async () => {
    const queue = new InvocationQueue(store);
    const entry = row('m-processing-evidence', 'opus');
    await store.enqueue([entry]);
    await queue.hydrateFromLedger();
    assert.ok(
      await queue.markProcessingDurable('thread-redis', 'owner-1', {
        entryId: entry.id,
        targetCats: ['opus'],
      }),
    );
    assert.equal(await queue.commitClaimedProcessing('thread-redis', [entry.id], 200), true);

    assert.equal(
      await queue.markProcessingAwakenedDurable(
        'thread-redis',
        'owner-1',
        entry.id,
        'opus',
        'inv-processing-evidence',
        210,
      ),
      true,
    );
    assert.deepEqual(
      await queue.markProcessingSeenDurable(
        'thread-redis',
        'owner-1',
        entry.id,
        'opus',
        'inv-processing-evidence',
        220,
      ),
      { changed: true, newlySeen: true },
    );

    const durable = await store.get('thread-redis', entry.id);
    assert.equal(durable.status, 'processing');
    assert.equal(durable.processingStartedAt, 200);
    assert.equal(durable.delivery.awakenedInvocationId, 'inv-processing-evidence');
    assert.equal(durable.delivery.awakenedAt, 210);
    assert.equal(durable.delivery.seenAt, 220);
    assert.equal(durable.delivery.seenInvocationId, 'inv-processing-evidence');
  });

  it('retires only the exposed source-target row and preserves its Redis tombstone evidence', async () => {
    const queue = new InvocationQueue(store);
    const admitted = await queue.appendAndEnqueueDurable(
      messageStore,
      {
        from: { kind: 'user', userId: 'owner-1' },
        userId: 'owner-1',
        content: 'shared input',
        mentions: ['opus', 'codex'],
        timestamp: 100,
        threadId: 'thread-redis',
        idempotencyKey: 'shared-input',
        deliveryStatus: 'queued',
      },
      {
        from: { kind: 'user', userId: 'owner-1' },
        threadId: 'thread-redis',
        userId: 'owner-1',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        idempotencyKey: 'shared-input',
        content: 'shared input',
        targetCats: ['opus', 'codex'],
        intent: 'execute',
      },
    );
    assert.equal(admitted.outcome, 'enqueued');
    const opus = admitted.entries.find((entry) => entry.target.kind === 'cat' && entry.target.catId === 'opus');
    const codex = admitted.entries.find((entry) => entry.target.kind === 'cat' && entry.target.catId === 'codex');
    assert.ok(opus);
    assert.ok(codex);

    const claimed = await queue.claimExactExposureDurable(
      'thread-redis',
      'owner-1',
      opus.id,
      'opus',
      admitted.message.id,
    );
    assert.equal(claimed?.id, opus.id);
    const committed = await queue.commitClaimedExposureDurable(
      'thread-redis',
      'owner-1',
      opus.id,
      'opus',
      'turn-read',
      200,
    );
    assert.equal(committed?.entry.id, opus.id);
    assert.equal(committed?.newlySeen, true);

    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => [entry.id, entry.status]),
      [[codex.id, 'queued']],
    );
    const durableOpus = await store.get('thread-redis', opus.id);
    assert.equal(durableOpus.status, 'terminal');
    assert.equal(durableOpus.delivery.terminalOutcome, 'handled');
    assert.equal(durableOpus.delivery.seenInvocationId, 'turn-read');
    assert.deepEqual(durableOpus.delivery.bodyExposures, [
      { targetCatId: 'opus', invocationId: 'turn-read', seenAt: 200 },
    ]);
    assert.deepEqual((await store.getByMessageIds('thread-redis', [admitted.message.id])).get(admitted.message.id), [
      durableOpus,
      codex,
    ]);
  });

  it('bounds queue admission scans to active order even when historical rows are corrupt', async () => {
    await redis.hset('queue:{thread-redis}:entries', 'historical-corrupt-row', '{not-json');
    const admitted = await store.enqueue([row('m-active', 'opus')], 1);
    assert.equal(admitted.outcome, 'enqueued');
    assert.deepEqual(
      await store.getByMessageIds('thread-redis', ['m-active']),
      new Map([['m-active', admitted.entries]]),
    );
  });

  it('atomically commits a Message and exact fan-out rows, and rejects Queue-full without a ghost', async () => {
    const queue = new InvocationQueue(store);
    const input = (idempotencyKey) => ({
      from: { kind: 'user', userId: 'owner-1' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      idempotencyKey,
      content: idempotencyKey,
      targetCats: ['opus', 'codex'],
      intent: 'execute',
    });
    const message = (idempotencyKey) => ({
      from: { kind: 'user', userId: 'owner-1' },
      userId: 'owner-1',
      content: idempotencyKey,
      mentions: ['opus', 'codex'],
      timestamp: 100,
      threadId: 'thread-redis',
      idempotencyKey,
      deliveryStatus: 'queued',
    });

    for (let index = 0; index < 5; index += 1) {
      const id = `request-${index}`;
      const admitted = await queue.appendAndEnqueueDurable(messageStore, message(id), input(id));
      assert.equal(admitted.outcome, 'enqueued');
      assert.ok(admitted.entries.every((entry) => entry.payload.messageId === admitted.message.id));
      assert.equal(admitted.message.timelinePublishedAtAppend, true);
      assert.deepEqual(
        await queue.getDurableEntriesForMessages('thread-redis', [admitted.message.id]),
        new Map([[admitted.message.id, admitted.entries]]),
      );
    }
    const beforeRows = await store.list('thread-redis');
    assert.equal(beforeRows.length, 10);

    const replay = await queue.appendAndEnqueueDurable(messageStore, message('request-0'), input('request-0'));
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.deduped, true);
    assert.equal((await store.list('thread-redis')).length, 10);

    const rejected = await queue.appendAndEnqueueDurable(
      messageStore,
      message('over-capacity'),
      input('over-capacity'),
    );
    assert.deepEqual(rejected, { outcome: 'full' });
    assert.equal(await messageStore.getByIdempotencyKey('owner-1', 'thread-redis', 'over-capacity'), null);
    assert.equal((await store.list('thread-redis')).length, 10);

    const published = await messageStore.getByIdempotencyKey('owner-1', 'thread-redis', 'request-0');
    const delivered = await messageStore.markDelivered(published.id, 500);
    assert.equal(delivered.timelineOrderAt, published.timestamp);
    assert.equal(await redis.zscore('msg:thread:thread-redis', published.id), String(published.timestamp));
  });

  it('atomically adopts an existing connector message and treats a terminal replay as no new work', async () => {
    const queue = new InvocationQueue(store);
    const source = await messageStore.append({
      from: { kind: 'external', connectorId: 'github' },
      userId: 'owner-1',
      content: 'connector event',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-redis',
    });
    const input = {
      from: source.from,
      threadId: source.threadId,
      userId: source.userId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: source.content,
      messageId: source.id,
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
    };

    const admitted = await queue.enqueueExistingMessageDurable(messageStore, source.id, input);
    assert.equal(admitted.outcome, 'enqueued');
    assert.equal(admitted.deduped, false);
    assert.equal((await messageStore.getById(source.id)).deliveryStatus, 'queued');
    assert.equal((await store.list(source.threadId)).length, 1);
    assert.equal(admitted.message.timelinePublishedAtAppend, undefined);
    assert.deepEqual(
      await queue.getDurableEntriesForMessages(source.threadId, [source.id]),
      new Map([[source.id, admitted.entries]]),
    );

    const entry = admitted.entry;
    assert.ok(entry);
    assert.ok(await queue.markProcessingByIdDurable(source.threadId, entry.id, 'opus'));
    assert.equal(await queue.commitClaimedProcessing(source.threadId, [entry.id], 200), true);
    assert.ok(await queue.removeProcessedDurable(source.threadId, source.userId, entry.id));
    await messageStore.markDelivered(source.id, 201);

    const replay = await queue.enqueueExistingMessageDurable(messageStore, source.id, input);
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.deduped, true);
    assert.equal(replay.entry, undefined);
    assert.deepEqual(await store.list(source.threadId), []);
    assert.equal((await store.get(source.threadId, entry.id)).status, 'terminal');
  });

  it('atomically terminalizes one response bubble with its outbound fan-out', async () => {
    const queue = new InvocationQueue(store);
    const response = (
      await messageStore.appendAndObservePriorFrontier({
        from: { kind: 'agent', catId: 'opus' },
        userId: 'owner-1',
        content: '',
        mentions: [],
        timestamp: 100,
        threadId: 'thread-redis',
        lifecycle: {
          kind: 'response',
          orderKey: '0000000000100:response-atomic',
          from: { kind: 'agent', catId: 'opus' },
          invocationId: 'invocation-atomic',
          targetId: 'opus',
          inputEntryIds: ['entry-input'],
          inputMessageIds: ['message-input'],
          status: 'processing',
          startedAt: 100,
        },
      })
    ).message;
    assert.deepEqual(await messageStore.getByThreadAfter('thread-redis', undefined, undefined, 'owner-1'), []);
    const input = {
      from: { kind: 'agent', catId: 'opus' },
      threadId: 'thread-redis',
      userId: 'owner-1',
      kind: 'message_wake',
      ownerAuthProvenance: 'strict',
      content: '@codex @sonnet review',
      messageId: response.id,
      sourceId: response.id,
      sourceCategory: 'a2a',
      targetCats: ['codex', 'sonnet'],
      intent: 'execute',
      autoExecute: true,
    };
    const patch = {
      invocationId: 'invocation-atomic',
      status: 'completed',
      completedAt: 200,
      content: input.content,
      mentions: ['codex', 'sonnet'],
      origin: 'stream',
    };

    const applied = await queue.terminalizeResponseAndEnqueueDurable(messageStore, response.id, patch, input);
    assert.equal(applied.outcome, 'enqueued');
    assert.equal(applied.deduped, false);
    assert.equal(applied.message.lifecycle.status, 'completed');
    assert.equal(typeof applied.message.visibilitySeq, 'number');
    assert.deepEqual(
      (await messageStore.getByThreadAfter('thread-redis', undefined, undefined, 'owner-1')).map(
        (message) => message.id,
      ),
      [response.id],
    );
    assert.deepEqual(applied.message.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'assigned' },
      { targetId: 'sonnet', phase: 'assigned' },
    ]);
    assert.deepEqual(
      (await store.list('thread-redis')).map((entry) => entry.target.catId),
      ['codex', 'sonnet'],
    );
    assert.deepEqual(
      await queue.getDurableEntriesForMessages('thread-redis', [response.id]),
      new Map([[response.id, applied.entries]]),
    );

    const replay = await queue.terminalizeResponseAndEnqueueDurable(messageStore, response.id, patch, input);
    assert.equal(replay.deduped, true);
    assert.equal((await store.list('thread-redis')).length, 2);
  });

  it('leaves a processing response unchanged when an outbound ledger identity conflicts', async () => {
    const queue = new InvocationQueue(store);
    const response = await messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      userId: 'owner-1',
      content: '',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-redis',
      lifecycle: {
        kind: 'response',
        orderKey: '0000000000100:response-conflict',
        from: { kind: 'agent', catId: 'opus' },
        invocationId: 'invocation-conflict',
        targetId: 'opus',
        inputEntryIds: ['entry-input'],
        inputMessageIds: ['message-input'],
        status: 'processing',
        startedAt: 100,
      },
    });
    const conflicting = row(response.id, 'codex');
    await store.enqueue([conflicting]);

    await assert.rejects(
      queue.terminalizeResponseAndEnqueueDurable(
        messageStore,
        response.id,
        {
          invocationId: 'invocation-conflict',
          status: 'completed',
          completedAt: 200,
          content: '@codex review',
          mentions: ['codex'],
        },
        {
          from: { kind: 'agent', catId: 'opus' },
          threadId: 'thread-redis',
          userId: 'owner-1',
          kind: 'message_wake',
          ownerAuthProvenance: 'strict',
          content: '@codex review',
          messageId: response.id,
          targetCats: ['codex'],
          intent: 'execute',
          autoExecute: true,
          sourceCategory: 'a2a',
        },
      ),
      /Queue admission conflict/,
    );
    assert.equal((await messageStore.getById(response.id)).lifecycle.status, 'processing');
    assert.deepEqual(await store.get('thread-redis', conflicting.id), conflicting);
  });
});
