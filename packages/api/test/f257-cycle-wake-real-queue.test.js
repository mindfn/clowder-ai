// F257: the delivery receipt has to exist in production, not only in a fake.
// This drives a wake from the real CycleEvaluationDelivery through the real
// scheduler deliver, ConnectorInvokeTrigger, InvocationQueue, QueueProcessor and
// Queue custody coordinator over a real MessageStore; only the provider is fake.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import {
  CycleEvaluationDelivery,
  resolveCycleWakeReceipt,
} from '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationDelivery.js';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const threadId = 'thread_eval_f257_obj';
const catId = 'codex-sol';
const record = { ownerUserId: 'owner-1', cycleId: 'cycle-1' };

function realQueue() {
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const evaluator = { busy: true };
  const providerStarts = [];
  const invocationTracker = {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    complete: noop,
    completeAll: noop,
    has: () => evaluator.busy,
  };
  let sequence = 0;
  const invocationRecordStore = {
    async create() {
      sequence += 1;
      return { outcome: 'created', invocationId: `inv-evaluator-${sequence}` };
    },
    async get() {
      return null;
    },
    async update() {
      return {};
    },
    async getByIdempotencyKey() {
      return null;
    },
  };
  const router = {
    async *routeExecution(...args) {
      providerStarts.push(args);
      // The provider launch boundary, exactly as invoke-single-cat crosses it: the
      // persisted prompt bodies are exposed to this exact child before it runs.
      const options = args.find((arg) => typeof arg?.onPromptMessagesExposed === 'function');
      await options.onPromptMessagesExposed({
        threadId,
        userId: record.ownerUserId,
        catId,
        invocationId: options.parentInvocationId,
        messageIds: options.persistedPromptMessageIds,
        seenAt: Date.now(),
      });
      yield { type: 'done', catId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const socketManager = { broadcastAgentMessage: noop, broadcastToRoom: noop, emitToUser: noop };
  const custody = new QueuedMessageCustodyCoordinator({ messageStore });
  const failure = { nextProcessingPersist: false, receiptWhileProcessing: undefined, wakeId: undefined };
  const persistEntry = custody.persistEntry.bind(custody);
  custody.persistEntry = async (entry) => {
    if (failure.nextProcessingPersist && entry.status === 'processing') {
      failure.nextProcessingPersist = false;
      // The window the review named: the row is `processing`, no provider child has the body.
      failure.receiptWhileProcessing = resolveCycleWakeReceipt(await messageStore.getById(failure.wakeId));
      throw new Error('custody persistence unavailable');
    }
    return persistEntry(entry);
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    queueCustodyCoordinator: custody,
    log,
  });
  const trigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue: queue,
    queueProcessor: processor,
    messageStore,
    log,
  });
  const delivery = new CycleEvaluationDelivery({
    runtime: { catalog: { registry: { objectives: [] } } },
    threadStore: {},
    deliver: createDeliverFn({ messageStore, socketManager }),
    getInvokeTrigger: () => trigger,
    getDefaultCatId: () => catId,
  });
  const receipt = async (id) => resolveCycleWakeReceipt(await messageStore.getById(id));
  const row = (id) => queue.findEntryWithMessageId(threadId, id);
  return { messageStore, processor, delivery, evaluator, providerStarts, failure, receipt, row };
}

test('a wake queued behind a busy evaluator is custodied; a failed start leaves it undelivered; the exposure delivers it', async () => {
  const q = realQueue();
  const wakeId = await q.delivery.deliverWake(
    record,
    threadId,
    catId,
    '## F257 Cycle Evaluation Assignment',
    'assignment',
  );
  await settle();

  const stored = await q.messageStore.getById(wakeId);
  assert.equal(stored.deliveryStatus, 'queued');
  assert.equal(stored.queueCustody?.status, 'queued', 'the connector trigger initialized durable Queue custody');
  assert.equal(q.row(wakeId)?.status, 'queued');
  assert.equal(q.providerStarts.length, 0, 'the evaluator is busy: nothing started');
  assert.deepEqual(await q.receipt(wakeId), { state: 'pending' });

  // The evaluator frees up, the queue reserves the wake, and the start fails before any provider child exists.
  q.evaluator.busy = false;
  q.failure.wakeId = wakeId;
  q.failure.nextProcessingPersist = true;
  await q.processor.tryAutoExecute(threadId, { bypassNonAgentGate: true });
  await settle();
  assert.deepEqual(q.failure.receiptWhileProcessing, { state: 'pending' }, 'processing is not a delivery receipt');
  assert.equal(q.row(wakeId)?.status, 'queued', 'the queue rolled the reservation back');
  assert.equal(q.providerStarts.length, 0);
  assert.deepEqual(await q.receipt(wakeId), { state: 'pending' }, 'queued → processing → queued delivered nothing');

  // The next start succeeds: the body reaches a provider child and the exposure is durable.
  const before = Date.now();
  await q.processor.tryAutoExecute(threadId, { bypassNonAgentGate: true });
  await settle();
  assert.equal(q.providerStarts.length, 1);
  const exposures = (await q.messageStore.getById(wakeId)).queueCustody?.bodyExposures ?? [];
  assert.equal(exposures.length, 1, 'exactly one exact body exposure is on the stored message');
  assert.equal(exposures[0].targetCatId, catId);
  const delivered = await q.receipt(wakeId);
  assert.deepEqual(delivered, { state: 'delivered', deliveredAt: exposures[0].seenAt });
  assert.ok(delivered.deliveredAt >= before && delivered.deliveredAt <= Date.now());
});

test('an idle evaluator gets the force-queued wake at once, with the same durable receipt', async () => {
  const q = realQueue();
  q.evaluator.busy = false;
  const wakeId = await q.delivery.deliverWake(
    record,
    threadId,
    catId,
    '## F257 Cycle Evaluation Retrigger',
    'retrigger',
  );
  await settle();
  assert.equal(q.providerStarts.length, 1, 'force-queue does not delay an idle thread');
  assert.equal((await q.receipt(wakeId)).state, 'delivered');
});
