/**
 * F167 × F254 — exact managed-hold disposition.
 *
 * Uses the real event log/projector/service and durable Queue ledger;
 * no sequence-shaped fake projection is allowed in this regression.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import {
  buildHandedEvent,
  buildHeldEvent,
  buildWakeConditionMetEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  ManagedHoldDispositionError,
  ManagedHoldDispositionService,
} from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';
import { ManagedHoldReceiptService } from '../dist/domains/ball-custody/ManagedHoldReceiptService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

class MemoryEventLog {
  events = [];
  failNextDispositionAppend = false;
  async append(event) {
    if (event.kind === 'ball.hold_dispositioned' && this.failNextDispositionAppend) {
      this.failNextDispositionAppend = false;
      throw new Error('event append failed');
    }
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    if (event.kind === 'ball.hold_dispositioned' && this.failNextDispositionAppend) {
      this.failNextDispositionAppend = false;
      throw new Error('event append failed');
    }
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { outcome: 'duplicate' };
    }
    const actualSequence = this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length;
    if (actualSequence !== expectedSequence) {
      return { outcome: 'conflict', actualSequence };
    }
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();
  failNextResolvedSave = false;
  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    if (projection.state === 'resolved' && this.failNextResolvedSave) {
      this.failNextResolvedSave = false;
      throw new Error('projection write failed');
    }
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

function managedTask(overrides = {}) {
  return {
    id: 'task-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      targetCatId: 'codex-sol',
      triggerUserId: 'user-1',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
        managedCommand: {
          state: 'enqueued',
          command: 'pnpm test',
          startedAt: 1_000,
          conditionMetAt: 2_000,
          wakeContent: 'tests passed',
          result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
          messageId: 'message-1',
          messageWrittenAt: 2_100,
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

async function harness({
  failDispositionAppendOnce = false,
  failDispositionProjectionOnce = false,
  beforeDispositionRecord,
} = {}) {
  const now = Date.now() + 1_000;
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  await ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 99_000, at: 1_000 }));
  await ingest.record(
    buildWakeConditionMetEvent({
      threadId: 'thread-1',
      catId: 'codex-sol',
      taskId: 'task-1',
      command: 'pnpm test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
      at: 2_000,
    }),
  );
  eventLog.failNextDispositionAppend = failDispositionAppendOnce;
  projectionStore.failNextResolvedSave = failDispositionProjectionOnce;

  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const stored = messageStore.append(
    canonicalTestMessageInput({
      id: 'ignored-by-store',
      userId: 'user-1',
      catId: null,
      from: { kind: 'system', service: 'hold-ball' },
      content: '[定时任务] tests passed',
      mentions: [],
      timestamp: 2_100,
      threadId: 'thread-1',
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: { taskId: 'task-1', threadId: 'thread-1', catId: 'codex-sol', wakeWhen: true },
      },
    }),
  );
  // route-serial persists this exact receiver-boundary handoff before the
  // managed wake invocation can call the disposition producer.
  await ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      toCatId: 'codex-sol',
      messageId: stored.id,
      at: 2_200,
    }),
  );
  // The production id is server-minted; bind every exact source below to it.
  const task = managedTask();
  task.params.holdLifecycle.managedCommand.messageId = stored.id;
  const enqueue = await queue.enqueueExistingMessageDurable(messageStore, stored.id, {
    kind: 'conversation_input',
    threadId: 'thread-1',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    content: stored.content,
    messageId: stored.id,
    from: { kind: 'system', service: 'hold-ball' },
    sourceCategory: 'scheduled',
    targetCats: ['codex-sol'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.ok(enqueue.entry);
  await queue.markQueuedSeenDurable('thread-1', 'user-1', enqueue.entry.id, 'codex-sol', 'inv-1', 3_000);
  const processing = await queue.markProcessingByIdDurable('thread-1', enqueue.entry.id, 'codex-sol');
  assert.ok(processing);
  assert.equal(await queue.commitClaimedProcessing('thread-1', [processing.id], 3_001), true);

  const tasks = new Map([['task-1', task]]);
  let latest = true;
  const receiptService = new ManagedHoldReceiptService({ queue, messageStore, now: () => now });
  const fencedIngest = beforeDispositionRecord
    ? {
        record: (event) => ingest.record(event),
        async recordFenced(event, expectedSequence) {
          if (event.kind === 'ball.hold_dispositioned') {
            await beforeDispositionRecord({ event, ingest });
          }
          return ingest.recordFenced(event, expectedSequence);
        },
      }
    : ingest;
  const service = new ManagedHoldDispositionService({
    registry: { isLatest: async () => latest },
    dynamicTaskStore: { getById: (id) => tasks.get(id) ?? null },
    messageStore,
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: fencedIngest,
    receiptService,
    repairProjection: (subjectKey) => projector.rebuild(subjectKey),
    now: () => now,
  });
  return {
    service,
    eventLog,
    projectionStore,
    queue,
    ingest,
    messageStore,
    task,
    tasks,
    stored,
    setLatest(value) {
      latest = value;
    },
  };
}

async function enqueueManagedWake(h, { taskId, invocationId, fireAt, at }) {
  const command = `pnpm test:${taskId}`;
  const stored = h.messageStore.append(
    canonicalTestMessageInput({
      id: 'ignored-by-store',
      userId: 'user-1',
      catId: null,
      from: { kind: 'system', service: 'hold-ball' },
      content: `[定时任务] ${taskId} passed`,
      mentions: [],
      timestamp: at + 100,
      threadId: 'thread-1',
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: { taskId, threadId: 'thread-1', catId: 'codex-sol', wakeWhen: true },
      },
    }),
  );
  const task = managedTask({ id: taskId, trigger: { type: 'once', fireAt } });
  task.params.holdLifecycle.wakeAt = fireAt;
  task.params.holdLifecycle.managedCommand = {
    state: 'enqueued',
    command,
    startedAt: at - 1_000,
    conditionMetAt: at,
    wakeContent: `${taskId} passed`,
    result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
    messageId: stored.id,
    messageWrittenAt: at + 100,
  };
  h.tasks.set(taskId, task);
  const enqueue = await h.queue.enqueueExistingMessageDurable(h.messageStore, stored.id, {
    kind: 'conversation_input',
    threadId: 'thread-1',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    content: stored.content,
    messageId: stored.id,
    from: { kind: 'system', service: 'hold-ball' },
    sourceCategory: 'scheduled',
    targetCats: ['codex-sol'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.ok(enqueue.entry);
  await h.queue.markQueuedSeenDurable('thread-1', 'user-1', enqueue.entry.id, 'codex-sol', invocationId, at + 200);
  const processing = await h.queue.markProcessingByIdDurable('thread-1', enqueue.entry.id, 'codex-sol');
  assert.ok(processing);
  assert.equal(await h.queue.commitClaimedProcessing('thread-1', [processing.id], at + 201), true);

  await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt, at }));
  await h.ingest.record(
    buildWakeConditionMetEvent({
      threadId: 'thread-1',
      catId: 'codex-sol',
      taskId,
      command,
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
      at: at + 1,
    }),
  );
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      toCatId: 'codex-sol',
      messageId: stored.id,
      at: at + 2,
    }),
  );
  return { stored, task };
}

function auth(h, overrides = {}) {
  return {
    invocationId: 'inv-1',
    callbackToken: 'token',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    catId: createCatId('codex-sol'),
    threadId: 'thread-1',
    originTriggerMessageId: h.stored.id,
    clientMessageIds: new Set(),
    createdAt: 1,
    expiresAt: 99_000,
    ...overrides,
  };
}

describe('F167 × F254 managed hold disposition', () => {
  test('a new managed hold reopens the same thread after a prior disposition and can complete', async () => {
    const h = await harness();
    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');

    const second = await enqueueManagedWake(h, {
      taskId: 'task-2',
      invocationId: 'inv-2',
      fireAt: 199_000,
      at: 4_000,
    });

    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'active');
    assert.equal(
      (
        await h.service.complete(
          auth(h, { invocationId: 'inv-2', originTriggerMessageId: second.stored.id }),
          'completed',
        )
      ).outcome,
      'applied',
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      2,
    );
  });

  test('a later A2A handoff to the holder replaces the older managed wake', async () => {
    const h = await harness();
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'codex-sol',
        messageId: 'replacement-message',
        at: 2_500,
      }),
    );

    // clowder-ai#1366 contract change: a replaced wake used to be a bare 409 with
    // NO custody event, which left the F167 stop gate with nothing to recognize
    // and made it reinject the same wake forever. It now reaches a durable
    // *retired* terminal that is inert on the subject plane.
    const result = await h.service.complete(auth(h), 'completed');
    assert.equal(result.retired, true);
    const dispositioned = (await h.eventLog.read('ball:thread:thread-1')).filter(
      (event) => event.kind === 'ball.hold_dispositioned',
    );
    assert.equal(dispositioned.length, 1);
    assert.equal(dispositioned[0].payload.retired, true);
    // The replacement holder keeps the ball; retiring the old wake must not resolve it.
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.holder, 'codex-sol');
    assert.notEqual(projection.state, 'resolved');
  });

  test('only the fenced producer writes one receipt + terminal event and releases the real stop gate', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: h.stored.id,
      taskId: 'task-1',
    });

    assert.equal((await gate.close(opened)).shouldBlock, true);
    const first = await h.service.complete(auth(h), 'completed');
    assert.equal(first.outcome, 'applied');
    assert.equal((await gate.close(opened)).shouldBlock, false);

    const receipt = await h.queue.getDurableEntry('thread-1', queueEntryId(h.stored.id, 'codex-sol'));
    assert.equal(receipt.status, 'terminal');
    assert.equal(receipt.delivery.seenInvocationId, 'inv-1');
    assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'delivered');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);

    const replay = await h.service.complete(auth(h), 'completed');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  test('generic Queue terminalization cannot write a managed-hold custody event', async () => {
    const h = await harness();
    const entry = h.queue.list('thread-1', 'user-1')[0];

    assert.ok(await h.queue.terminalizeEntryDurable('thread-1', 'user-1', entry.id));
    assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'queued');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('concurrent conflicting dispositions linearize to one event and reject the loser', async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.service.complete(auth(h), 'handled'),
      h.service.complete(auth(h), 'completed'),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  test('a stale disposition cannot resolve a successor holder after the holder check', async () => {
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        await ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'successor-message',
            at: 2_500,
          }),
        );
      },
    });

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      /^ManagedHoldDispositionError: managed_hold_disposition_fence_conflict$/,
    );
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.state, 'active');
    assert.equal(projection.holder, 'opus');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
    assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'queued');
  });

  test('repairs projection when the exact event append wins before projection persistence fails', async () => {
    const h = await harness({ failDispositionProjectionOnce: true });

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
    assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'delivered');
    assert.equal(
      (await h.queue.getDurableEntry('thread-1', queueEntryId(h.stored.id, 'codex-sol'))).status,
      'terminal',
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  test('does not consume the exact receipt when the custody event was not appended', async () => {
    const h = await harness({ failDispositionAppendOnce: true });

    await assert.rejects(() => h.service.complete(auth(h), 'completed'), /event append failed/);

    assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'queued');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('wrong source/task/invocation/thread/holder and stale/replaced attempts fail closed', async () => {
    for (const mutate of [
      (h) => auth(h, { originTriggerMessageId: 'other-message' }),
      (h) => auth(h, { invocationId: 'other-invocation' }),
      (h) => auth(h, { threadId: 'other-thread' }),
      (h) => auth(h, { catId: createCatId('opus') }),
      (h) => {
        h.task.id = 'replacement-task';
        return auth(h);
      },
      (h) => {
        h.setLatest(false);
        return auth(h);
      },
    ]) {
      const h = await harness();
      await assert.rejects(() => h.service.complete(mutate(h), 'completed'), ManagedHoldDispositionError);
      assert.equal(h.messageStore.getById(h.stored.id).deliveryStatus, 'queued');
    }
  });

  test('a dequeued managed wake is terminalized instead of restored to Queue', async () => {
    const h = await harness();
    const entry = h.queue.list('thread-1', 'user-1')[0];
    assert.ok(await h.queue.terminalizeEntryDurable('thread-1', 'user-1', entry.id));
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    const terminal = await h.queue.getDurableEntry('thread-1', entry.id);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.delivery.seenInvocationId, 'inv-1');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('re-hold advances only to its new condition without terminalizing the original ball', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: h.stored.id,
      taskId: 'task-1',
    });

    await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 199_000, at: 4_000 }));

    assert.equal((await gate.close(opened)).shouldBlock, false);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).heldUntil, 199_000);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
    // clowder-ai#1366: the re-held ball is a *newer* obligation. Retiring the old
    // wake gives it a terminal without advancing the new hold to resolved.
    const result = await h.service.complete(auth(h), 'completed');
    assert.equal(result.retired, true);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).heldUntil, 199_000);
    assert.notEqual((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
  });
});
