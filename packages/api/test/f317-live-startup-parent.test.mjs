import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

const cancelled = { type: 'done', catId: 'codex', errorCode: 'INVOCATION_CANCELLED' };
const cases = [
  ['Host stop with error and done', [{ ...cancelled, type: 'error', error: 'Host stopped' }, cancelled], 'canceled'],
  ['Host stop with done only', [cancelled], 'canceled'],
  ['real failure before Host stop', [{ type: 'error', catId: 'codex', error: 'real failure' }, cancelled], 'failed'],
  ['real failure after Host stop', [cancelled, { type: 'error', catId: 'codex', error: 'real failure' }], 'failed'],
  ['successful peer survives Host stop', [cancelled, { type: 'done', catId: 'opus' }], 'succeeded'],
];

function fixture(events) {
  const records = new InvocationRecordStore();
  const tracker = new InvocationTracker();
  const queue = new InvocationQueue();
  const parentIds = [];
  const completions = [];
  const targetCats = [...new Set(events.map((event) => event.catId))];
  const router = {
    resolveTargetsAndIntent: async () => ({ targetCats, intent: { intent: 'execute' } }),
    resolveExplicitTargets: async () => targetCats,
    async *routeExecution() {
      for (const event of events) yield { ...event, timestamp: Date.now() };
    },
    ackCollectedCursors: async () => {},
  };
  const deps = {
    registry: new InvocationRegistry(),
    messageStore: new MessageStore(),
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router,
    invocationTracker: tracker,
    invocationQueue: queue,
    queue,
    invocationRecordStore: {
      async create(input) {
        const result = records.create(input);
        parentIds.push(result.invocationId);
        return result;
      },
      update: (id, input) => records.update(id, input),
      get: (id) => records.get(id),
    },
    queueProcessor: {
      clearPause() {},
      async onInvocationComplete(...args) {
        completions.push(args);
      },
    },
    threadStore: { get: async () => ({ id: 'home', createdBy: 'owner', title: 'Home' }) },
    log: { info() {}, warn() {}, error() {} },
  };
  return { records, tracker, queue, parentIds, completions, targetCats, deps };
}

for (const [label, events, expected] of cases) {
  test(`messages parent and completion preserve ${label}`, async () => {
    const h = fixture(events);
    const app = Fastify();
    await app.register(messagesRoutes, h.deps);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-cat-cafe-user': 'owner' },
        payload: { content: '@codex Host Live bootstrap', threadId: 'home' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const deadline = Date.now() + 2000;
      while (h.completions.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(h.completions.length, 1, 'route must finish the exact parent');
      assert.equal(h.records.get(h.parentIds[0]).status, expected, 'actual parent record');
      assert.equal(h.completions[0][2], expected, 'queue completion receives the same disposition');
      assert.deepEqual(h.completions[0][4], expected === 'succeeded' ? ['opus'] : []);
    } finally {
      await app.close();
    }
  });

  test(`queued parent preserves ${label}`, async () => {
    const h = fixture(events);
    const processor = new QueueProcessor(h.deps);
    h.queue.enqueue({
      threadId: 'home',
      userId: 'owner',
      content: 'Host Live bootstrap',
      source: 'user',
      ownerAuthProvenance: 'unknown',
      targetCats: h.targetCats,
      intent: 'execute',
    });
    const result = await processor.executeEntry(h.queue.markProcessing('home', 'owner'));
    assert.equal(result.status, expected, 'queue result');
    assert.equal(h.records.get(h.parentIds[0]).status, expected, 'actual queued parent record');
    assert.deepEqual(result.successfulCatIds, expected === 'succeeded' ? ['opus'] : []);
  });
}
