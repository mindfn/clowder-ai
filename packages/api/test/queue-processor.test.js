import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

let sourceSequence = 0;

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out waiting for Queue transition'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createInvocationRecordStore() {
  const records = new Map();
  let invocationSequence = 0;
  return {
    records,
    create: mock.fn(async (input) => {
      const invocationId = `inv-${++invocationSequence}`;
      const now = Date.now();
      records.set(invocationId, {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      return { outcome: 'created', invocationId };
    }),
    get: mock.fn(async (invocationId) => records.get(invocationId) ?? null),
    update: mock.fn(async (invocationId, patch) => {
      const current = records.get(invocationId);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: Date.now() };
      records.set(invocationId, next);
      return next;
    }),
  };
}

function createHarness({ routeExecution, tracker = new InvocationTracker() } = {}) {
  const queue = new InvocationQueue();
  const messageStore = new MessageStore();
  const invocationRecordStore = createInvocationRecordStore();
  const routeCalls = [];
  const router = {
    resolveExplicitTargets: mock.fn(async (targetCats) => [...targetCats]),
    resolveConversationTargetsAtAdmission: mock.fn(async (targetCats) =>
      targetCats.length > 0 ? [...targetCats] : ['opus'],
    ),
    routeExecution: mock.fn(
      routeExecution ??
        async function* (...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: args[4][0], isFinal: true, timestamp: Date.now() };
        },
    ),
    ackCollectedCursors: mock.fn(async () => {}),
  };
  const socketManager = {
    broadcastAgentMessage: mock.fn(),
    broadcastToRoom: mock.fn(),
    emitToUser: mock.fn(),
  };
  const deps = {
    queue,
    invocationTracker: tracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
  return { ...deps, processor: new QueueProcessor(deps), routeCalls };
}

function errorLog(harness) {
  return harness.log.error.mock.calls.map((call) =>
    call.arguments.map((argument) => {
      if (argument?.err instanceof Error) {
        return { ...argument, err: { message: argument.err.message, stack: argument.err.stack } };
      }
      return argument;
    }),
  );
}

async function admitMessage(harness, overrides = {}) {
  sourceSequence += 1;
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: `queue-processor-${sourceSequence}`,
    content: `body-${sourceSequence}`,
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  const messageInput = canonicalTestMessageInput({
    threadId: queueInput.threadId,
    userId: queueInput.userId,
    catId: null,
    from: queueInput.from,
    content: queueInput.content,
    mentions: queueInput.targetCats,
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const result = await harness.queue.appendAndEnqueueDurable(harness.messageStore, messageInput, queueInput);
  assert.equal(result.outcome, 'enqueued');
  assert.ok(result.entry);
  return result;
}

describe('QueueProcessor over ADR-043 durable scalar ledger', () => {
  it('claims, admits, and terminalizes one queued message without reviving it', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);

    const started = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(started.started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    const durable = await harness.queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(durable.status, 'terminal');
    assert.equal(durable.delivery.terminalOutcome, 'handled', JSON.stringify(errorLog(harness)));
    assert.equal((await harness.messageStore.getById(admitted.message.id)).deliveryStatus, 'delivered');
  });

  it('keeps a FIFO prefix as separate prompt messages instead of concatenating bodies', async () => {
    const calls = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        calls.push(args);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const first = await admitMessage(harness, { content: 'first author body' });
    const second = await admitMessage(harness, { content: 'second author body' });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.list('thread-1', 'user-1').length === 0);

    assert.equal(calls.length, 1, JSON.stringify(errorLog(harness)));
    const [userId, content, threadId, messageId, targetCats, , options] = calls[0];
    assert.equal(userId, 'user-1');
    assert.equal(threadId, 'thread-1');
    assert.equal(content, 'first author body');
    assert.equal(messageId, first.message.id);
    assert.deepEqual(targetCats, ['opus']);
    assert.deepEqual(
      options.persistedPromptMessages.map((message) => ({ messageId: message.messageId, content: message.content })),
      [
        { messageId: first.message.id, content: 'first author body' },
        { messageId: second.message.id, content: 'second author body' },
      ],
    );
    assert.equal(content.includes('second author body'), false);
  });

  it('terminalizes provider failure and never puts the admitted row back in Queue', async () => {
    const harness = createHarness({
      routeExecution: async function* () {
        throw new Error('provider failed');
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    const durable = await harness.queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(durable.status, 'terminal');
    assert.equal(durable.delivery.terminalOutcome, 'failed');
    assert.equal(durable.delivery.failureReason, 'invocation_failed');
  });

  it('terminalizes a canceled admitted row instead of rolling it back behind later work', async () => {
    let releaseProvider;
    let providerStarted;
    const providerStartedPromise = new Promise((resolve) => {
      providerStarted = resolve;
    });
    const harness = createHarness({
      routeExecution: async function* () {
        providerStarted();
        await new Promise((resolve) => {
          releaseProvider = resolve;
        });
      },
    });
    const first = await admitMessage(harness, { content: 'first' });
    const second = await admitMessage(harness, { content: 'second', targetCats: ['codex'] });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await providerStartedPromise;
    harness.invocationTracker.cancel('thread-1', 'opus', 'user-1', 'preempted');
    releaseProvider();
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', first.entry.id) === null);

    const durable = await harness.queue.getDurableEntry('thread-1', first.entry.id);
    assert.equal(durable.status, 'terminal');
    assert.equal(durable.delivery.terminalOutcome, 'cancelled');
    assert.equal(
      harness.queue.list('thread-1', 'user-1').some((entry) => entry.id === first.entry.id),
      false,
    );
    assert.equal(
      harness.queue.list('thread-1', 'user-1').some((entry) => entry.id === second.entry.id),
      true,
    );
  });

  it('starts an exact Steer claim and advances claimed to processing before provider execution', async () => {
    let harness;
    let observedStatus;
    harness = createHarness({
      routeExecution: async function* () {
        observedStatus = harness.queue.list('thread-1', 'user-1')[0]?.status;
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const admitted = await admitMessage(harness);
    const claim = await harness.queue.claimExactSteerEntryDurable('thread-1', 'user-1', admitted.entry.id, 'opus');
    assert.equal(claim.outcome, 'claimed');
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'claimed');

    const started = await harness.processor.processClaimedSteerEntries(
      'thread-1',
      'user-1',
      [admitted.entry.id],
      'opus',
    );
    assert.equal(started.started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);
    assert.equal(observedStatus, 'processing', JSON.stringify(errorLog(harness)));
  });

  it('restores a claimed Steer row in its original place when the target slot is busy', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);
    const claim = await harness.queue.claimExactSteerEntryDurable('thread-1', 'user-1', admitted.entry.id, 'opus');
    assert.equal(claim.outcome, 'claimed');
    harness.invocationTracker.start('thread-1', 'opus', 'user-1');

    const started = await harness.processor.processClaimedSteerEntries(
      'thread-1',
      'user-1',
      [admitted.entry.id],
      'opus',
    );
    assert.equal(started.started, false);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
  });

  it('terminalizes a public head when explicit routing resolves no target', async () => {
    const harness = createHarness();
    harness.router.resolveConversationTargetsAtAdmission.mock.mockImplementation(async () => []);
    const admitted = await admitMessage(harness);

    const result = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(result.started, false);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);
    const durable = await harness.queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(durable.delivery.terminalOutcome, 'failed');
  });
});
