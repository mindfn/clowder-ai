import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  commitLifecycleResponseFromAppendInput,
  MessageStore,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

async function waitFor(predicate) {
  const until = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Queue did not converge');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness({ guide = false } = {}) {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const store = new MessageStore();
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let created = 0;
  const recordMap = new Map();
  const records = {
    create: mock.fn(async (input) => {
      const invocationId = `inv-${++created}`;
      if (created === 1) await createGate;
      const record = {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      recordMap.set(invocationId, record);
      return { outcome: 'created', invocationId };
    }),
    get: async (id) => recordMap.get(id) ?? null,
    update: async (id, patch) => {
      const current = recordMap.get(id);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: Date.now() };
      recordMap.set(id, next);
      return next;
    },
    listRunningByThread: async () => [],
  };
  const socketManager = { emitToUser: mock.fn(), broadcastToRoom() {}, broadcastAgentMessage() {} };
  const routeExecution = mock.fn(async function* (userId, _content, threadId, messageId, targets, _intent, options) {
    for (const catId of targets) {
      const childId = `child-${created}-${catId}`;
      const lifecycleAdmission = await options.onLifecycleInvocationStarted({
        threadId,
        userId,
        catId,
        invocationId: childId,
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      await options.onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId: childId,
        messageIds: [messageId],
        seenAt: Date.now(),
      });
      await commitLifecycleResponseFromAppendInput(
        store,
        lifecycleAdmission.responseMessageId,
        childId,
        { status: 'completed', completedAt: Date.now() },
        {
          from: { kind: 'agent', catId },
          userId,
          threadId,
          content: 'handled exact source',
          mentions: [],
          timestamp: Date.now(),
          replyTo: messageId,
          extra: {
            causal: { kind: 'invocation_reply', triggerMessageId: messageId },
            stream: { invocationId: `inv-${created}`, turnInvocationId: childId },
          },
        },
      );
      yield { type: 'done', catId, invocationId: childId, isFinal: true, timestamp: Date.now() };
    }
  });
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
    router: {
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      resolveExplicitTargets: async (targets) => [...targets],
      routeExecution,
      ackCollectedCursors: async () => {},
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    sourceId: 'issue1371-prestart-source',
    ...(guide ? { ownerAuthProvenance: 'strict', autoExecute: true } : {}),
    content: 'independent targets',
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  });
  const admitted = await queue.send(
    store,
    canonicalTestMessageInput({
      threadId: queueInput.threadId,
      userId: queueInput.userId,
      from: queueInput.from,
      catId: null,
      mentions: queueInput.targetCats,
      content: queueInput.content,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    queueInput,
  );
  const source = admitted.message;
  const entry = admitted.entry;
  const app = Fastify();
  await app.register(queueRoutes, {
    resolveCarrierCapability: () => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    }),
    threadStore: { get: async () => ({ id: 'thread-1', createdBy: 'user-1', participants: ['opus', 'codex'] }) },
    invocationQueue: queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
  });
  return {
    queue,
    tracker,
    store,
    processor,
    records,
    source,
    entry,
    routeExecution,
    releaseCreate,
    app,
  };
}

function bindAppendRun(h, catId) {
  const parent = `parent-${catId}`,
    invocationId = `turn-${catId}`,
    startedAt = Date.now();
  h.tracker.start('thread-1', catId, 'user-1', [catId], parent);
  const response = h.store.append({
    from: { kind: 'agent', catId },
    userId: 'user-1',
    threadId: 'thread-1',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  assert.ok(
    h.tracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId: catId,
        invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt,
      },
      parent,
    ),
  );
  return { invocationId, responseId: response.id };
}

for (const strategy of ['guide_reply', 'interrupt_reply']) {
  test(`old Console follow-up after ${strategy} cannot deliver or interrupt twice`, async (t) => {
    const h = await harness({ guide: strategy === 'guide_reply' });
    t.after(() => h.app.close());
    h.releaseCreate();
    let nativeCalls = 0;
    if (strategy === 'guide_reply') {
      const run = bindAppendRun(h, 'opus');
      h.tracker.bindAgentClientActiveRunDispatcher('thread-1', 'opus', {
        invocationId: run.invocationId,
        capabilities: { append: true, steer: true },
        handle: { provider: 'openai_codex', carrier: 'codex_app_server' },
        dispatch: async () => {
          nativeCalls++;
          return { accepted: true, handle: {} };
        },
      });
    }
    const first = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        sourceRecordId: h.source.id,
        observedPendingTargetIds: ['opus', 'codex'],
        targets: [{ targetCatId: 'opus', strategy, membershipAtOpen: 'member' }],
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    const after = JSON.stringify(h.store.getById(h.source.id).lifecycle);
    const duplicate = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread-1/queue/${h.entry.id}/${strategy === 'guide_reply' ? 'continue' : 'steer'}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { targetCatId: 'opus' },
    });
    assert.equal(duplicate.statusCode, 404, duplicate.body);
    assert.equal(duplicate.json().code, 'ENTRY_NOT_FOUND');
    assert.equal(JSON.stringify(h.store.getById(h.source.id).lifecycle), after);
    assert.equal(nativeCalls, strategy === 'guide_reply' ? 1 : 0);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });
}

for (const firstResult of ['accepted', 'rejected', 'throws']) {
  test(`one guide request releases the sibling at handoff while preserving a delayed ${firstResult} ACK`, async (t) => {
    const h = await harness({ guide: true });
    t.after(() => h.app.close());
    h.releaseCreate();
    const runs = { opus: bindAppendRun(h, 'opus'), codex: bindAppendRun(h, 'codex') };
    let releaseAck;
    const ackGate = new Promise((resolve) => {
      releaseAck = resolve;
    });
    const calls = [];
    for (const catId of ['opus', 'codex']) {
      assert.ok(
        h.tracker.bindAgentClientActiveRunDispatcher('thread-1', catId, {
          invocationId: runs[catId].invocationId,
          capabilities: { append: true, steer: true },
          handle: { provider: 'openai_codex', carrier: 'codex_app_server' },
          dispatch: async () => {
            calls.push(catId);
            if (catId === 'opus') {
              await ackGate;
              if (firstResult === 'throws') throw new Error('native append refused');
              if (firstResult === 'rejected') return { accepted: false, reason: 'provider_rejected' };
            }
            return { accepted: true, handle: {} };
          },
        }),
      );
    }
    let requestFinished = false;
    const request = h.app
      .inject({
        method: 'POST',
        url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
        headers: { 'x-cat-cafe-user': 'user-1' },
        payload: {
          sourceRecordId: h.source.id,
          observedPendingTargetIds: ['opus', 'codex'],
          targets: ['opus', 'codex'].map((targetCatId) => ({
            targetCatId,
            strategy: 'guide_reply',
            membershipAtOpen: 'member',
          })),
        },
      })
      .then((response) => {
        requestFinished = true;
        return response;
      });
    let blocked;
    try {
      await waitFor(() => calls.includes('codex'));
      assert.equal(requestFinished, false, 'final per-target results must still include the held ACK');
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0, 'both targets handed off before the slow ACK');
    } catch (error) {
      blocked = error;
    } finally {
      releaseAck();
    }
    const response = await request;
    assert.ifError(blocked);
    assert.equal(response.statusCode, 200, response.body);
    const targets = response.json().targets;
    assert.deepEqual(calls, ['opus', 'codex'], 'one dispatch per target');
    assert.equal(targets[1].result.outcome, 'appended');
    assert.equal(targets[1].status, 200);
    if (firstResult === 'accepted') {
      assert.equal(targets[0].result.outcome, 'appended');
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    } else {
      assert.equal(targets[0].status, 502);
      assert.equal(targets[0].result.code, 'PROVIDER_REJECTED');
      assert.equal(
        h.queue.list('thread-1', 'user-1').length,
        0,
        'native refusal follows the shared settled-failure path',
      );
      const refs = h.store.getById(h.source.id).lifecycle.dispatchRefs;
      const refused = refs.find((ref) => ref.targetId === 'opus');
      const accepted = refs.find((ref) => ref.targetId === 'codex');
      assert.equal(refused.phase, 'settled');
      const failure = h.store.getById(refused.statusMessageId);
      assert.equal(failure.lifecycle.kind, 'delivery_failure');
      assert.equal(failure.lifecycle.status, 'failed');
      assert.equal(failure.lifecycle.inputMessageId, h.source.id);
      assert.deepEqual(failure.lifecycle.requestedTargets, ['opus']);
      assert.equal(accepted.phase, 'dispatched');
      assert.equal(accepted.statusMessageId, runs.codex.responseId);
      assert.ok(h.store.getById(runs.codex.responseId).lifecycle.inputMessageIds.includes(h.source.id));
      assert.ok(!h.store.getById(runs.opus.responseId).lifecycle.inputMessageIds.includes(h.source.id));
    }
  });
}

test('one Steer request interrupts two busy targets through real Queue handoff and replays without new runs', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  const opus = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'old-opus');
  const codex = h.tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'old-codex');
  h.releaseCreate();
  const input = {
    method: 'POST',
    url: `/api/threads/thread-1/queue/${h.entry.id}/targets`,
    headers: { 'x-cat-cafe-user': 'user-1' },
    payload: {
      sourceRecordId: h.source.id,
      observedPendingTargetIds: ['opus', 'codex'],
      targets: [
        { targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
      ],
    },
  };
  const res = await h.app.inject(input);
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(
    res.json().targets.map((target) => [target.targetCatId, target.status, target.result.started]),
    [
      ['opus', 200, true],
      ['codex', 200, true],
    ],
  );
  assert.equal(opus.signal.aborted, true);
  assert.equal(codex.signal.aborted, true);
  assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  assert.deepEqual(
    h.store
      .getById(h.source.id)
      .lifecycle.dispatchRefs.map((ref) => ref.targetId)
      .sort(),
    ['codex', 'opus'],
  );
  const before = h.records.create.mock.callCount();
  const replay = await h.app.inject(input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().targets, []);
  assert.deepEqual(replay.json().skippedAlreadyDispatched, ['opus', 'codex']);
  assert.equal(h.records.create.mock.callCount(), before);
});

test('#1371: explicit Steer consumes one target and preserves the busy sibling', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');

  const claimed = await h.queue.claimExactSteerEntryDurable('thread-1', 'user-1', h.entry.id, 'codex');
  assert.equal(claimed.outcome, 'claimed');
  const started = h.processor.processClaimedSteerEntries(
    'thread-1',
    'user-1',
    claimed.entries.map((entry) => entry.id),
    'codex',
  );
  await waitFor(() => h.records.create.mock.calls.length === 1);
  h.releaseCreate();
  assert.equal((await started).started, true);
  await waitFor(
    () => h.store.getById(h.source.id).lifecycle?.dispatchRefs?.some((ref) => ref.targetId === 'codex') === true,
  );
  assert.equal(busy.signal.aborted, false);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['codex']],
  );
  assert.deepEqual(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).targets, ['opus']);

  h.tracker.completeAll('thread-1', ['opus'], busy);
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['codex'], ['opus']],
  );
});

for (const entryPoint of ['manual', 'automatic']) {
  test(`#1371: ${entryPoint} drain keeps the exact target set queued while one sibling is busy`, async (t) => {
    const h = await harness();
    t.after(() => h.app.close());
    const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');

    if (entryPoint === 'manual') {
      await h.processor.processNext('thread-1', 'user-1');
    } else {
      await h.processor.requestDrain('thread-1');
    }

    assert.equal(h.records.create.mock.calls.length, 0);
    assert.equal(h.routeExecution.mock.calls.length, 0);
    assert.deepEqual(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).targets, ['opus', 'codex']);

    h.tracker.completeAll('thread-1', ['opus'], busy);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => h.records.create.mock.calls.length === 1);
    h.releaseCreate();
    await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['opus', 'codex']],
    );
    assert.deepEqual(
      h.store
        .getById(h.source.id)
        .lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.phase])
        .sort(),
      [
        ['codex', 'settled'],
        ['opus', 'settled'],
      ],
    );
  });
}

test('#1371: a sibling becoming busy during ordinary preflight requeues without losing or failing custody', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);

  const busy = h.tracker.start('thread-1', 'codex', 'user-1', ['codex'], 'independent-work');
  h.releaseCreate();
  await waitFor(() => h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id)?.status === 'queued');

  const remaining = h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id);
  assert.equal(remaining.status, 'queued');
  assert.deepEqual(remaining.queuedFailedByCatIds ?? [], []);
  assert.deepEqual(remaining.targets, ['opus', 'codex']);
  assert.deepEqual(h.store.getById(h.source.id).lifecycle?.dispatchRefs ?? [], []);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.equal(busy.signal.aborted, false);
  assert.equal((await h.records.get('inv-1')).status, 'canceled');
  assert.equal((await h.records.get('inv-1')).error, 'queue_target_became_busy');

  h.tracker.completeAll('thread-1', ['codex'], busy);
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
  assert.deepEqual(
    h.routeExecution.mock.calls.map((call) => call.arguments[4]),
    [['opus', 'codex']],
  );
});

test('#1371: force-reset retires a recordless pre-start target without running the provider', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);

  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });
  h.releaseCreate();
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'canceled');
  assert.deepEqual(h.store.getById(h.source.id).lifecycle.dispatchRefs, []);
});

test('#1371: pre-start terminal write failure is visible and the exact retry succeeds', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const removeProcessed = h.queue.removeProcessedAcrossUsersDurable.bind(h.queue);
  h.queue.removeProcessedAcrossUsersDurable = async () => null;
  const request = {
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  };
  const failed = await h.app.inject(request);
  assert.equal(failed.statusCode, 503, failed.body);
  h.queue.removeProcessedAcrossUsersDurable = removeProcessed;
  const retried = await h.app.inject(request);
  h.releaseCreate();
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
});

test('#1371: live pre-start recovery never acquires another user live target', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const foreign = h.tracker.start('thread-1', 'codex', 'other-user', ['codex'], 'foreign-work');

  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });

  assert.equal(reset.statusCode, 409, reset.body);
  assert.equal(foreign.signal.aborted, false);
  assert.equal(h.tracker.getUserId('thread-1', 'codex'), 'other-user');
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'queued');
  assert.equal(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).status, 'claimed');

  h.releaseCreate();
  await waitFor(() => h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id)?.status === 'queued');
});
