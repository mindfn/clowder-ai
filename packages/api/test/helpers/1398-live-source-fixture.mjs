import assert from 'node:assert/strict';
import Fastify from 'fastify';
import './setup-cat-registry.js';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { QueueProcessor } from '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { InMemoryTurnExecutionStore } from '../../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { DeliveryCursorStore } from '../../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts';
import { InvocationRecordStore } from '../../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.ts';
import { LiveInbox } from '../../src/domains/concierge/live/inbox/LiveInbox.ts';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.ts';
import { LiveCarrierOperationGate } from '../../src/domains/concierge/live/LiveCarrierOperationGate.ts';
import { callbacksRoutes } from '../../src/routes/callbacks.ts';
import { appendTestLifecycleResponseSource } from './message-from-fixtures.js';

// Actual atomic Queue admission, callback auth, exact Live child and close gate.
// Notifications contain references; only the real full-body callback delivers a target.
export async function createCanonicalLiveSourceFixture(intent, source = 'user', options = {}) {
  const queue = new InvocationQueue(options.ledgerStore);
  const store = options.messageStore ?? new MessageStore();
  const targetCats = options.targetCats ?? ['codex-astra', 'kimi'];
  const socketManager = options.socketManager ?? {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
  const registry = new InvocationRegistry();
  const tracker = new InvocationTracker();
  const turns = options.turnExecutionStore ?? new InMemoryTurnExecutionStore();
  const gate = new LiveCarrierOperationGate();
  const cursorStore = new DeliveryCursorStore();
  const auth = await registry.create('owner', 'codex-astra', 'home', 'live-parent');
  const scope = {
    userId: 'owner',
    threadId: 'home',
    catId: 'codex-astra',
    invocationId: auth.invocationId,
    parentInvocationId: 'live-parent',
    callId: 'call',
    generation: 1,
  };
  await turns.createRunning({
    ...scope,
    executionKind: 'ordinary',
    ...(options.ordinary ? {} : { queueCompletionPolicy: 'explicit_source' }),
    startedAt: Date.now(),
  });
  tracker.start('home', 'codex-astra', 'owner', ['codex-astra'], 'live-parent');
  const response = await appendTestLifecycleResponseSource(store, {
    userId: scope.userId,
    threadId: scope.threadId,
    catId: scope.catId,
    invocationId: auth.invocationId,
    timestamp: Date.now(),
  });
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId: scope.threadId,
        targetId: scope.catId,
        invocationId: auth.invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt: Date.now(),
      },
      'live-parent',
    ),
    true,
  );
  const from =
    source === 'agent'
      ? { kind: 'agent', catId: 'opus' }
      : source === 'connector'
        ? { kind: 'external', connectorId: 'test' }
        : { kind: 'user', userId: 'owner' };
  const admitted = await queue.appendAndEnqueueDurable(
    store,
    {
      threadId: 'home',
      userId: 'owner',
      from,
      content: 'actual queued body',
      mentions: targetCats,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      kind: 'conversation_input',
      threadId: 'home',
      userId: 'owner',
      from,
      ownerAuthProvenance: 'strict',
      content: 'actual queued body',
      targetCats,
      intent: 'execute',
      ...(intent ? { authorIntentByCatId: { 'codex-astra': intent } } : {}),
    },
  );
  assert.ok(admitted.message && admitted.entry);
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: store,
    turnExecutionStore: turns,
    invocationRecordStore: new InvocationRecordStore(),
    router: options.router ?? {},
    socketManager,
    log: { info() {}, warn() {}, error() {} },
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: store,
    invocationQueue: queue,
    invocationTracker: tracker,
    turnExecutionStore: turns,
    queueProcessor: processor,
    deliveryCursorStore: cursorStore,
    withLiveCarrierOperation:
      options.withLiveCarrierOperation ?? ((query, consume) => gate.runForCarrier(query, consume)),
    socketManager,
  });
  const deliveries = [];
  const inboxSource = new MessageLiveInboxSource({ store, queue, authorize: async () => true });
  const inbox = new LiveInbox({
    scope,
    source: inboxSource,
    wake() {},
    deliver: async (batch) => {
      deliveries.push(batch);
      return 'accepted';
    },
  });
  const read = (query = '') =>
    app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context?responseMode=full' + query,
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
  async function close() {
    inbox.close();
    gate.close();
    await gate.drain();
    await app.close();
  }
  return {
    gate,
    turns,
    tracker,
    processor,
    registry,
    auth,
    app,
    queue,
    store,
    response,
    message: admitted.message,
    entry: admitted.entry,
    inbox,
    inboxSource,
    deliveries,
    read,
    scope,
    cursorStore,
    close,
  };
}
export async function assertPendingLiveSource(f) {
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['codex-astra', 'kimi']);
  assert.equal(f.store.getById(f.message.id).lifecycle.dispatchRefs?.length ?? 0, 0);
}
export async function assertDeliveredLiveSource(f) {
  const input = f.store.getById(f.message.id);
  const [ref] = input.lifecycle.dispatchRefs;
  assert.equal(ref.targetId, 'codex-astra');
  assert.equal(ref.statusMessageId, f.response.id);
  assert.equal(ref.phase, 'dispatched');
  const response = f.store.getById(ref.statusMessageId);
  assert.equal(response.lifecycle.invocationId, f.scope.invocationId);
  assert.equal(response.lifecycle.status, 'processing', 'delivery is not business completion');
  assert.ok(response.lifecycle.inputMessageIds.includes(f.message.id));
  assert.deepEqual((await f.queue.getDurableEntry('home', f.entry.id)).targets, ['kimi']);
  assert.equal(Object.hasOwn(input, 'queueCustody'), false);
}
