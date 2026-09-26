// F117 Phase M: the Queue hands an Append to the running carrier and retires its row at once, but the
// input is read only when the carrier reports consumption. Until then it waits on its dispatchRef and
// stays out of History; a run that ends first publishes it unread; a rejection publishes it with the
// failure. It is never returned to the Queue.
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { MessageStore, settleLifecycleResponseInputs } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
);

let sequence = 0;

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness() {
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const invocationTracker = new InvocationTracker();
  const socketManager = { broadcastAgentMessage: mock.fn(), broadcastToRoom: mock.fn(), emitToUser: mock.fn() };
  const deps = {
    queue,
    invocationTracker,
    invocationRecordStore: { create: mock.fn(), get: mock.fn(async () => null), update: mock.fn() },
    router: {
      resolveExplicitTargets: mock.fn(async (targets) => [...targets]),
      resolveConversationTargetsAtAdmission: mock.fn(async (targets) => [...targets]),
      routeExecution: mock.fn(async function* () {}),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager,
    messageStore,
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
  return { ...deps, processor: new QueueProcessor(deps, { retryDeferral: { baseDelayMs: 60_000 } }) };
}

async function admit(harness) {
  sequence += 1;
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: `phase-m-append-${sequence}`,
    content: `append body ${sequence}`,
    targetCats: ['opus'],
    intent: 'execute',
  });
  const result = await harness.queue.appendAndEnqueueDurable(
    harness.messageStore,
    canonicalTestMessageInput({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      from: queueInput.from,
      content: queueInput.content,
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    queueInput,
  );
  assert.equal(result.outcome, 'enqueued');
  return result;
}

function bindRun(harness, dispatch) {
  const invocationId = `turn-phase-m-${sequence}`;
  const startedAt = Date.now();
  harness.invocationTracker.start('thread-1', 'opus', 'user-1', ['opus'], 'parent-phase-m');
  const response = harness.messageStore.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'user-1',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    threadId: 'thread-1',
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  assert.equal(
    harness.invocationTracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId: 'opus',
        invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt,
      },
      'parent-phase-m',
    ),
    true,
  );
  assert.ok(
    harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', 'opus', {
      invocationId,
      capabilities: { append: true, steer: true },
      handle: { provider: 'anthropic', carrier: 'claude_agent_sdk', threadId: 's', turnId: 't' },
      dispatch,
    }),
  );
  return { invocationId, response };
}

async function append(harness, admitted, run) {
  return harness.processor.appendExactEntry({
    threadId: 'thread-1',
    userId: 'user-1',
    entryId: admitted.entry.id,
    expectedQueueRevision: harness.queue.snapshotRevision('thread-1', 'user-1'),
    expectedRuns: [{ targetId: 'opus', invocationId: run.invocationId, responseMessageId: run.response.id }],
  });
}

const deliveredEmits = (harness) =>
  harness.socketManager.emitToUser.mock.calls
    .filter((call) => call.arguments[1] === 'messages_delivered')
    .flatMap((call) => call.arguments[2].messageIds);
const activeInputs = (harness) => harness.invocationTracker.getActiveSlots('thread-1')[0].activeRun.inputMessageIds;

describe('F117 Phase M: an appended input is read when its carrier reports consumption', () => {
  it('waits in History, out of the timeline, until consumption; then joins the response with its read time', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const consumption = deferred();
    const run = bindRun(harness, async () => ({ accepted: true, handle: {}, consumption: consumption.promise }));

    const result = await append(harness, admitted, run);
    assert.equal(result.outcome, 'appended');
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null, 'the row retires');

    let source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'queued', 'not in the timeline before it is read');
    assert.equal(source.lifecycle.dispatchRefs.length, 1);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, 'awaiting');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
    let response = (await harness.messageStore.getById(run.response.id)).lifecycle;
    assert.deepEqual(response.inputMessageIds, []);
    assert.deepEqual(response.handedInputMessageIds, [admitted.message.id]);
    assert.deepEqual(activeInputs(harness), [], 'the live run does not claim an input it has not read');
    assert.deepEqual(deliveredEmits(harness), []);

    const readAt = Date.now() + 5;
    consumption.resolve({ consumed: true, at: readAt });
    await waitFor(async () =>
      (await harness.messageStore.getById(run.response.id)).lifecycle.inputMessageIds.includes(admitted.message.id),
    );
    await waitFor(() => deliveredEmits(harness).includes(admitted.message.id));

    source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].readAt, readAt);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.deliveredAt, readAt);
    response = (await harness.messageStore.getById(run.response.id)).lifecycle;
    assert.equal(response.handedInputMessageIds, undefined);
    assert.deepEqual(activeInputs(harness), [admitted.message.id]);
  });

  it('publishes an Append the run closed without reading, and its response settles it unread', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const consumption = deferred();
    const run = bindRun(harness, async () => ({ accepted: true, handle: {}, consumption: consumption.promise }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');

    consumption.resolve({ consumed: false });
    await waitFor(() => deliveredEmits(harness).includes(admitted.message.id));
    const published = await harness.messageStore.getById(admitted.message.id);
    assert.equal(published.deliveryStatus, 'delivered', 'never left queued without a Queue row');
    assert.equal(published.lifecycle.dispatchRefs[0].readState, 'awaiting', 'the response has not ended yet');
    assert.deepEqual(activeInputs(harness), []);

    const terminal = harness.messageStore.commitLifecycleResponseTerminal(run.response.id, {
      invocationId: run.invocationId,
      status: 'canceled',
      completedAt: Date.now() + 10,
      content: '',
      mentions: [],
      origin: 'stream',
    });
    assert.equal(terminal.kind, 'applied');
    await settleLifecycleResponseInputs(harness.messageStore, terminal.message, run.response.id);
    const unread = await harness.messageStore.getById(admitted.message.id);
    assert.equal(unread.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(unread.lifecycle.dispatchRefs[0].readState, 'unread');
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null, 'not re-queued');
  });

  it('publishes a rejected Append with its failure instead of leaving it queued', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: false, reason: 'active_run_closed' }));

    const result = await append(harness, admitted, run);
    assert.equal(result.outcome, 'rejected');
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.notEqual(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    const failure = await harness.messageStore.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
    assert.equal(failure.lifecycle.kind, 'delivery_failure');
    assert.equal((await harness.messageStore.getById(run.response.id)).lifecycle.handedInputMessageIds, undefined);
    assert.equal(
      harness.log.warn.mock.calls.some((call) => String(call.arguments[1]).includes('already closed')),
      false,
      'a handed Append was never mirrored into the live run, so there is nothing to detach',
    );
  });

  it('keeps an Append waiting when its carrier cannot report consumption', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: true, handle: {} }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, 'awaiting');
    assert.equal(source.deliveryStatus, 'queued', 'published only when its response settles');
  });
});
