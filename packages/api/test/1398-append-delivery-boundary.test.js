import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { PersistedQueueDelivery } = await import(
  '../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js'
);
const { MessageStore, settleLifecycleResponseInputs } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
);
let sequence = 0;

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

async function admit(harness, overrides = {}) {
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
    ...overrides,
  });
  const result = await harness.queue.appendAndEnqueueDurable(
    harness.messageStore,
    canonicalTestMessageInput({
      threadId: 'thread-1',
      userId: queueInput.userId,
      catId: null,
      from: queueInput.from,
      content: queueInput.content,
      mentions: ['opus'],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
      ...(overrides.messageSource ? { source: overrides.messageSource } : {}),
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
  const releaseCarrier = harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', 'opus', {
    invocationId,
    capabilities: { append: true, steer: true },
    handle: { provider: 'anthropic', carrier: 'claude_agent_sdk', threadId: 's', turnId: 't' },
    dispatch,
  });
  assert.equal(typeof releaseCarrier, 'function');
  return { invocationId, response, releaseCarrier };
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

describe('delivery owns Append admission, without model-read state', () => {
  for (const connector of ['github-wait', 'scheduled', 'other-connector']) {
    it(`producer ${connector} appends through its actual durable delivery path and does not replay`, async () => {
      const harness = createHarness();
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      const delivery = new PersistedQueueDelivery({
        messages: harness.messageStore,
        queue: harness.queue,
        progress: (entry, target) => harness.processor.progressOwnedCarrier(entry, target),
      });
      const carrier = {
        v: 1,
        waitId: 'task-pr-221',
        outcomeId: `wait:${connector}:221:merged`,
        ownerFence: { kind: 'containing_task', generation: 1 },
      };
      const input = {
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        targetCatId: 'opus',
        ownerAuthProvenance: 'strict',
        idempotencyKey: `producer-append-${connector}`,
        content: 'PR state: merged',
        source: { connector, label: connector, meta: { waitContinuationCarrier: carrier } },
        ...(connector === 'scheduled' ? { from: { kind: 'system', service: 'scheduler' } } : {}),
        waitContinuationCarrier: carrier,
      };
      const result = await delivery.deliver(input);
      assert.equal(result.state, 'already_processing');
      assert.equal(dispatch.mock.calls.length, 1);
      assert.equal(result.message.lifecycle.kind, 'input');
      assert.deepEqual(activeInputs(harness), [result.message.id]);
      const source = harness.messageStore.getById(result.message.id);
      assert.equal(source.deliveryStatus, 'delivered');
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
      assert.deepEqual(source.source.meta.waitContinuationCarrier, carrier);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', result.entryId), null);
      const replay = await delivery.deliver(input);
      assert.equal(replay.message.id, result.message.id);
      assert.equal(dispatch.mock.calls.length, 1, 'same persisted producer identity must not append twice');
      const independent = await delivery.deliver({ ...input, idempotencyKey: `${input.idempotencyKey}:second` });
      assert.notEqual(independent.message.id, result.message.id, 'same text with another source remains independent');
      assert.equal(dispatch.mock.calls.length, 2);
      assert.deepEqual(activeInputs(harness), [result.message.id, independent.message.id]);
      assert.equal(harness.router.routeExecution.mock.calls.length, 0, 'no second turn is started');
    });
  }

  for (const boundary of ['unsupported', 'suppressed', 'private', 'owner_mismatch', 'bound_parent', 'system_pinned']) {
    it(`producer progress retains its queued carrier at the ${boundary} boundary`, async () => {
      const harness = createHarness();
      const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
      const run = bindRun(harness, dispatch);
      if (boundary === 'unsupported') run.releaseCarrier();
      if (boundary === 'suppressed') harness.processor.suppressAutoResume('thread-1', 'opus');
      const queueOverrides = {
        from: { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } },
        ...(boundary === 'owner_mismatch' ? { userId: 'different-owner' } : {}),
        ...(boundary === 'system_pinned'
          ? { from: { kind: 'agent', catId: 'opus' }, sourceCategory: 'continuation' }
          : {}),
      };
      const admitted =
        boundary === 'private'
          ? await harness.queue.enqueueDurable(
              canonicalTestQueueInput({
                threadId: 'thread-1',
                userId: 'user-1',
                sourceId: 'private-producer',
                content: 'private work',
                targetCats: ['opus'],
                intent: 'execute',
                ...queueOverrides,
                kind: 'private_input',
              }),
            )
          : await admit(harness, queueOverrides);
      if (boundary === 'bound_parent') {
        await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
          requested: 'continue_current',
          boundParentInvocationId: 'different-parent',
        });
      }
      const progress = await harness.processor.progressOwnedCarrier(admitted.entry, 'opus');
      assert.equal(progress, boundary === 'suppressed' ? 'owned_deferred_suppressed' : 'owned_deferred_busy');
      assert.equal(dispatch.mock.calls.length, 0);
      assert.equal(
        harness.queue.getEntrySnapshot('thread-1', admitted.entry.owner.userId, admitted.entry.id).status,
        'queued',
      );
      assert.deepEqual(activeInputs(harness), []);
    });
  }

  it('auto Append honors a connector target choice and exact parent, preserving source identity', async () => {
    const harness = createHarness();
    const from = { kind: 'external', connectorId: 'github-wait', sender: { id: 'github-wait' } };
    const carrier = {
      v: 1,
      waitId: 'task-pr-216',
      outcomeId: 'wait:pr:mindfn/clowder-ai:216:g1:matched',
      ownerFence: { kind: 'containing_task', generation: 1 },
    };
    const admitted = await admit(harness, {
      from,
      waitContinuationCarrier: carrier,
      messageSource: { connector: 'github-wait', label: 'GitHub Wait', meta: { waitContinuationCarrier: carrier } },
    });
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const run = bindRun(harness, dispatch);
    await harness.queue.bindContinueCurrentIntentDurable('thread-1', 'user-1', admitted.entry.id, 'opus', {
      requested: 'continue_current',
      boundParentInvocationId: 'different-parent',
    });
    assert.equal(
      (
        await harness.processor.tryAutoAppendExactEntry({
          threadId: 'thread-1',
          userId: 'user-1',
          entryId: admitted.entry.id,
          targetCatId: 'opus',
        })
      ).outcome,
      'rejected',
    );
    assert.equal(dispatch.mock.calls.length, 0);
    const bound = await harness.queue.bindContinueCurrentIntentDurable(
      'thread-1',
      'user-1',
      admitted.entry.id,
      'opus',
      {
        requested: 'continue_current',
        boundParentInvocationId: harness.invocationTracker.getExecutionId('thread-1', 'opus'),
      },
    );
    assert.ok(bound);
    assert.deepEqual(bound.from, from);
    assert.deepEqual(bound.execution.waitContinuationCarrier, carrier);
    const result = await harness.processor.tryAutoAppendExactEntry({
      threadId: 'thread-1',
      userId: 'user-1',
      entryId: admitted.entry.id,
      targetCatId: 'opus',
    });
    assert.equal(result.outcome, 'appended');
    assert.equal(dispatch.mock.calls.length, 1);
    assert.equal(harness.invocationTracker.has('thread-1', 'opus'), true);
    assert.deepEqual((await harness.messageStore.getById(admitted.message.id)).from, from);
    assert.deepEqual(activeInputs(harness), [admitted.message.id]);
    assert.deepEqual(
      (await harness.messageStore.getById(admitted.message.id)).source.meta.waitContinuationCarrier,
      carrier,
    );
  });

  it('publishes and binds accepted input immediately even when the carrier never reports consumption', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const consumption = deferred();
    const run = bindRun(harness, async () => ({ accepted: true, handle: {}, consumption: consumption.promise }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.ok(deliveredEmits(harness).includes(source.id));
    const updates = harness.socketManager.emitToUser.mock.calls
      .filter((call) => call.arguments[1] === 'message_lifecycle_updated' && call.arguments[2].message.id === source.id)
      .map((call) => call.arguments[2].message);
    assert.ok(updates.length > 0);
    assert.deepEqual(
      updates.map((message) => message.timelineOrderAt),
      updates.map(() => source.timelineOrderAt),
      'lifecycle events must not overwrite a delivered input with its queued admission snapshot',
    );
    assert.deepEqual(activeInputs(harness), [source.id]);
    const response = await harness.messageStore.getById(run.response.id);
    assert.deepEqual(response.lifecycle.inputMessageIds, [source.id]);
    assert.equal(response.lifecycle.handedInputMessageIds, undefined);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    assert.equal(source.lifecycle.dispatchRefs[0].readAt, undefined);
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('keeps delivery terminal when a member fails before consuming the appended input', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: true, handle: {} }));
    assert.equal((await append(harness, admitted, run)).outcome, 'appended');
    const terminal = harness.messageStore.commitLifecycleResponseTerminal(run.response.id, {
      invocationId: run.invocationId,
      status: 'failed',
      completedAt: Date.now() + 10,
      content: '成员处理失败',
      mentions: [],
      origin: 'stream',
    });
    assert.equal(terminal.kind, 'applied');
    await settleLifecycleResponseInputs(harness.messageStore, terminal.message, run.response.id);
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, run.response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].readState, undefined);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });

  it('publishes one exact failure when the carrier rejects delivery without resurrecting Queue work', async () => {
    const harness = createHarness();
    const admitted = await admit(harness);
    const run = bindRun(harness, async () => ({ accepted: false, reason: 'active_run_closed' }));
    assert.equal((await append(harness, admitted, run)).outcome, 'rejected');
    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    const ref = source.lifecycle.dispatchRefs[0];
    assert.equal(ref.phase, 'settled');
    assert.notEqual(ref.statusMessageId, run.response.id);
    assert.equal((await harness.messageStore.getById(ref.statusMessageId)).lifecycle.kind, 'delivery_failure');
    assert.deepEqual(activeInputs(harness), []);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
  });
});
