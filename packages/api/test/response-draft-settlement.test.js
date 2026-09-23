import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { lifecycleResponseIdempotencyKey, settleResponseFromDraft } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);

const USER = 'user-1';
const THREAD = 'thread-1';

function appendProcessingResponse(store, invocationId, { content = '', lifecycleInvocationId = invocationId } = {}) {
  return store.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: USER,
    content,
    mentions: [],
    origin: 'stream',
    timestamp: 100,
    threadId: THREAD,
    idempotencyKey: lifecycleResponseIdempotencyKey(invocationId),
    extra: { stream: { invocationId: 'parent-1', turnInvocationId: invocationId } },
    lifecycle: {
      kind: 'response',
      orderKey: `100:${lifecycleInvocationId}`,
      invocationId: lifecycleInvocationId,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
}

function upsertDraft(drafts, invocationId, overrides = {}) {
  return drafts.upsert({
    userId: USER,
    threadId: THREAD,
    invocationId,
    catId: 'opus',
    content: 'streamed so far',
    updatedAt: Date.now(),
    ...overrides,
  });
}

function settle(store, drafts, emitted, input) {
  return settleResponseFromDraft(
    { messageStore: store, draftStore: drafts, emit: (userId, message) => emitted.push({ userId, message }) },
    { userId: USER, threadId: THREAD, status: 'failed', reason: 'execution_owner_lost', endedAt: 300, ...input },
  );
}

describe('F117 KD-21 settleResponseFromDraft', () => {
  test('a processing R takes the streamed draft body with its terminal state, then the draft goes', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1');
    const toolEvent = { id: 'tool-1', type: 'tool_use', label: 'Read', timestamp: 120 };
    await upsertDraft(drafts, 'turn-1', {
      content:
        'partial answer\n```cc_rich\n{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"Summary","tone":"info"}]}\n```',
      toolEvents: [toolEvent, { unrelated: true }],
      thinking: 'weighing options',
    });
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, {
      invocationId: 'turn-1',
      explanation: '执行进程归属已丢失',
    });

    assert.equal(settlement.kind, 'committed');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'failed');
    assert.equal(stored.lifecycle.reason, 'execution_owner_lost');
    assert.equal(stored.lifecycle.completedAt, 300);
    assert.equal(stored.content, 'partial answer\n\n执行进程归属已丢失');
    assert.deepEqual(stored.toolEvents, [toolEvent]);
    assert.equal(stored.thinking, 'weighing options');
    assert.deepEqual(stored.extra.stream, { invocationId: 'parent-1', turnInvocationId: 'turn-1' });
    assert.deepEqual(
      stored.extra.rich.blocks.map((block) => block.id),
      ['b1'],
    );
    assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
    assert.deepEqual(
      emitted.map(({ userId, message }) => [userId, message.id, message.lifecycle.status]),
      [[USER, response.id, 'failed']],
    );
  });

  test('without a draft the R keeps its own body and the explanation is appended once', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1', { content: 'own body\n\n执行控制面不可用' });

    const settlement = await settle(store, drafts, [], {
      invocationId: 'turn-1',
      status: 'interrupted',
      reason: 'process_restart',
      explanation: '执行控制面不可用',
    });

    assert.equal(settlement.kind, 'committed');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'interrupted');
    assert.equal(stored.content, 'own body\n\n执行控制面不可用');
  });

  test('an R that is already terminal keeps its body and only sheds the leftover draft', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    const response = await appendProcessingResponse(store, 'turn-1');
    await store.commitLifecycleResponseTerminal(response.id, {
      invocationId: 'turn-1',
      status: 'completed',
      completedAt: 200,
      content: 'the committed answer',
      mentions: [],
    });
    await upsertDraft(drafts, 'turn-1', { content: 'an older partial' });
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, { invocationId: 'turn-1' });

    assert.equal(settlement.kind, 'already_terminal');
    const stored = await store.getById(response.id);
    assert.equal(stored.lifecycle.status, 'completed');
    assert.equal(stored.content, 'the committed answer');
    assert.deepEqual(await drafts.getByThread(USER, THREAD), []);
    assert.equal(emitted.length, 1);
  });

  test('a turn without a response R leaves its draft alone', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    await upsertDraft(drafts, 'turn-orphan');
    const emitted = [];

    const settlement = await settle(store, drafts, emitted, { invocationId: 'turn-orphan' });

    assert.deepEqual(settlement, { kind: 'no_response' });
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 1);
    assert.equal(emitted.length, 0);
  });

  test('a rejected commit throws and keeps the draft for whoever settles R next', async () => {
    const store = new MessageStore();
    const drafts = new DraftStore();
    // The admission key names turn-1 but the lifecycle belongs to another turn: the store refuses.
    const response = await appendProcessingResponse(store, 'turn-1', { lifecycleInvocationId: 'turn-other' });
    await upsertDraft(drafts, 'turn-1');
    const emitted = [];

    await assert.rejects(settle(store, drafts, emitted, { invocationId: 'turn-1' }), /invocation_mismatch/);

    assert.equal((await store.getById(response.id)).lifecycle.status, 'processing');
    assert.equal((await drafts.getByThread(USER, THREAD)).length, 1);
    assert.equal(emitted.length, 0);
  });
});
