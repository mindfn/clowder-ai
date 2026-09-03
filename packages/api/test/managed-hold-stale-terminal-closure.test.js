/**
 * F167 × clowder-ai#1366 — stale / adopted managed-hold terminal lifecycle.
 *
 * Two symptoms, one root cause: an exact (sourceMessageId, taskId) wake has no
 * durable terminal of its own, so a late or superseded wake can neither be
 * dispositioned nor recognized as resolved — and the F167 stop gate reinjects it
 * forever, blocking unrelated healthy turns.
 *
 * Real event log / projector / disposition service / turn-custody projection.
 * No sequence-shaped fake projection is allowed in this regression.
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
import { ManagedHoldDispositionService } from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';
import { ManagedHoldReceiptService } from '../dist/domains/ball-custody/ManagedHoldReceiptService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const THREAD = 'thread-1';
const USER = 'user-1';
const CAT = 'codex-sol';
const SUBJECT = `ball:thread:${THREAD}`;

class MemoryEventLog {
  events = [];
  async append(event) {
    if (this.events.some((c) => c.sourceEventId === event.sourceEventId)) return { appended: false, sequence: -1 };
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    if (this.events.some((c) => c.sourceEventId === event.sourceEventId)) return { outcome: 'duplicate' };
    const actual = this.events.filter((c) => c.subjectKey === event.subjectKey).length;
    if (actual !== expectedSequence) return { outcome: 'conflict', actualSequence: actual };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((e) => e.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((e) => e.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();
  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

function managedTask({ id, messageId, state, fireAt }) {
  return {
    id,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt },
    params: {
      message: 'fallback',
      targetCatId: CAT,
      triggerUserId: USER,
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: fireAt,
        managedCommand: {
          state,
          command: `pnpm test:${id}`,
          startedAt: 1_000,
          conditionMetAt: 2_000,
          wakeContent: 'tests passed',
          result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
          messageId,
          messageWrittenAt: 2_100,
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: THREAD,
    enabled: true,
    createdBy: `hold-ball:${CAT}`,
    createdAt: new Date(1_000).toISOString(),
  };
}

/** One managed wake, end to end through the real carriers. */
async function harness() {
  const now = Date.now() + 1_000;
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const tasks = new Map();

  async function deliverWake({ taskId, invocationId, at, state = 'enqueued' }) {
    const stored = messageStore.append(
      canonicalTestMessageInput({
        id: 'ignored-by-store',
        userId: USER,
        catId: null,
        from: { kind: 'system', service: 'hold-ball' },
        content: `[定时任务] ${taskId} passed`,
        mentions: [],
        timestamp: at + 100,
        threadId: THREAD,
        source: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId, threadId: THREAD, catId: CAT, wakeWhen: true },
        },
      }),
    );
    tasks.set(taskId, managedTask({ id: taskId, messageId: stored.id, state, fireAt: at }));
    const enqueue = await queue.enqueueExistingMessageDurable(messageStore, stored.id, {
      kind: 'conversation_input',
      threadId: THREAD,
      userId: USER,
      ownerAuthProvenance: 'unknown',
      content: stored.content,
      messageId: stored.id,
      from: { kind: 'system', service: 'hold-ball' },
      sourceCategory: 'scheduled',
      targetCats: [CAT],
      intent: 'execute',
      priority: 'normal',
    });
    assert.ok(enqueue.entry);
    await queue.markQueuedSeenDurable(THREAD, USER, enqueue.entry.id, CAT, invocationId, at + 200);
    const processing = await queue.markProcessingByIdDurable(THREAD, enqueue.entry.id, CAT);
    assert.ok(processing);
    assert.equal(await queue.commitClaimedProcessing(THREAD, [processing.id], at + 201), true);

    await ingest.record(buildHeldEvent({ threadId: THREAD, catId: CAT, fireAt: at + 90_000, at }));
    await ingest.record(
      buildWakeConditionMetEvent({
        threadId: THREAD,
        catId: CAT,
        taskId,
        command: `pnpm test:${taskId}`,
        exitCode: 0,
        timedOut: false,
        durationMs: 1_000,
        at: at + 1,
      }),
    );
    await ingest.record(buildHandedEvent({ threadId: THREAD, toCatId: CAT, messageId: stored.id, at: at + 2 }));
    return { stored, taskId };
  }

  let latestInvocationId = 'inv-1';
  const realReceiptService = new ManagedHoldReceiptService({ queue, messageStore, now: () => now });
  let failNextReceipt = false;
  const receiptService = {
    async complete(input) {
      if (failNextReceipt) {
        failNextReceipt = false;
        // Production order writes the custody event first, then settles F264.
        // This models the window where the event is durable but the receipt is not.
        throw new Error('receipt write failed');
      }
      return realReceiptService.complete(input);
    },
  };
  const service = new ManagedHoldDispositionService({
    registry: { isLatest: async (id) => id === latestInvocationId },
    dynamicTaskStore: { getById: (id) => tasks.get(id) ?? null },
    messageStore,
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: ingest,
    receiptService,
    repairProjection: (subjectKey) => projector.rebuild(subjectKey),
    now: () => now,
  });
  const gate = new TurnCustodyProjectionService({
    ballCustodyProjectionStore: projectionStore,
    ballCustodyEventLog: eventLog,
  });

  function restartService() {
    // Simulates a process restart: same durable event log + projection store,
    // brand new service instance with no in-memory carry-over.
    return new ManagedHoldDispositionService({
      registry: { isLatest: async (id) => id === latestInvocationId },
      dynamicTaskStore: { getById: (id) => tasks.get(id) ?? null },
      messageStore,
      ballCustodyEventLog: eventLog,
      ballCustodyProjectionStore: projectionStore,
      ballCustody: ingest,
      receiptService,
      repairProjection: (subjectKey) => projector.rebuild(subjectKey),
      now: () => now,
    });
  }

  return {
    eventLog,
    projectionStore,
    queue,
    messageStore,
    restartService,
    failReceiptOnce() {
      failNextReceipt = true;
    },
    ingest,
    tasks,
    service,
    gate,
    deliverWake,
    setLatest(id) {
      latestInvocationId = id;
    },
  };
}

function auth({ invocationId, sourceMessageId }) {
  return {
    invocationId,
    callbackToken: 'token',
    userId: USER,
    ownerAuthProvenance: 'unknown',
    catId: createCatId(CAT),
    threadId: THREAD,
    originTriggerMessageId: sourceMessageId,
    clientMessageIds: new Set(),
    createdAt: 1,
    expiresAt: 9_999_999,
  };
}

function holdWake({ sourceMessageId, taskId }) {
  return {
    kind: 'structured',
    protocol: 'hold',
    subjectKey: SUBJECT,
    holderCatId: CAT,
    sourceMessageId,
    taskId,
  };
}

async function dispositionEvents(h) {
  return (await h.eventLog.read(SUBJECT)).filter((e) => e.kind === 'ball.hold_dispositioned');
}

describe('F167 stale/adopted managed-hold terminal closure (clowder-ai#1366)', () => {
  // ── RED 1: #1366 as filed — late primary wake whose task already went terminal.
  test('a late primary wake whose dynamic task is terminal still reaches a terminal disposition', async () => {
    const h = await harness();
    const { stored, taskId } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    // The command task left the active delivery states before the callback was consumed.
    h.tasks.get(taskId).params.holdLifecycle.managedCommand.state = 'consumed';

    const result = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');
    assert.equal(typeof result.outcome, 'string');
    assert.equal(result.sourceMessageId, stored.id);
    assert.equal(result.taskId, taskId);

    const events = await dispositionEvents(h);
    assert.equal(events.length, 1, 'exactly one terminal custody event for the exact late wake');
    assert.equal(events[0].payload.taskId, taskId);
    assert.equal(events[0].payload.sourceMessageId, stored.id);
  });

  test('duplicate disposition of the same late wake is idempotent', async () => {
    const h = await harness();
    const { stored, taskId } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    h.tasks.get(taskId).params.holdLifecycle.managedCommand.state = 'consumed';

    const first = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');
    const second = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');
    assert.equal(second.outcome, 'replayed');
    assert.equal(first.taskId, second.taskId);
    assert.equal((await dispositionEvents(h)).length, 1, 'no duplicate ball.hold_dispositioned');
  });

  // ── RED 2: our live site — replacement happened BEFORE an unrelated turn adopted the old wake.
  test('a wake superseded before adoption does not block the adopting turn', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    // A newer managed hold replaces it while the old callback is still unconsumed.
    const second = await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });

    // An unrelated, healthy turn now reads the queue and adopts the OLD wake.
    const adopted = await h.gate.open(holdWake({ sourceMessageId: first.stored.id, taskId: first.taskId }));
    const decision = await h.gate.close(adopted);

    assert.equal(
      decision.shouldBlock,
      false,
      'a wake already superseded before adoption must not block an unrelated successful turn',
    );
    assert.notEqual(adopted.state, 'unknown_legacy');
    assert.ok(second.stored.id);
  });

  // ── Guard (must stay GREEN): legitimate post-adoption continuation is NOT retired early.
  test('a rehold after adoption still counts as continuation for the adopted wake', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    const adopted = await h.gate.open(holdWake({ sourceMessageId: first.stored.id, taskId: first.taskId }));
    assert.equal(adopted.state, 'covered_active', 'a live wake is a real obligation at adoption time');

    // The cat legitimately reholds during this same turn (#3636 continuation witness).
    await h.ingest.record(buildHeldEvent({ threadId: THREAD, catId: CAT, fireAt: 200_000, at: 120_000 }));

    const decision = await h.gate.close(adopted);
    assert.equal(decision.transitionObserved, true);
    assert.equal(decision.structuredTransitionKind, 'held');
    assert.equal(decision.shouldBlock, false);
  });

  test('a handoff after adoption still counts as continuation for the adopted wake', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    const adopted = await h.gate.open(holdWake({ sourceMessageId: first.stored.id, taskId: first.taskId }));

    await h.ingest.record(
      buildHandedEvent({ threadId: THREAD, fromCatId: CAT, toCatId: 'fable5', messageId: 'handoff-1', at: 120_000 }),
    );

    const decision = await h.gate.close(adopted);
    assert.equal(decision.transitionObserved, true);
    assert.equal(decision.structuredTransitionKind, 'handed');
    assert.equal(decision.shouldBlock, false);
  });

  // ── Guard: retiring the old wake must never terminate the newer active hold.
  test('settling a superseded wake leaves the newer hold untouched', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });

    const before = await h.projectionStore.get(SUBJECT);
    assert.equal(before.holder, CAT);
    assert.ok(before.state === 'active' || before.state === 'blocked');

    // The old wake must actually reach a terminal (not silently throw) — otherwise
    // this guard would pass vacuously while the liveness loop is still live.
    h.setLatest('inv-1');
    const result = await h.service.complete(
      auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }),
      'handled',
    );
    assert.equal(result.retired, true, 'a superseded wake terminates as retired, not as a subject resolution');
    const written = await dispositionEvents(h);
    assert.equal(written.length, 1, 'the retired terminal is durable for the stop gate');
    assert.equal(written[0].payload.retired, true);
    assert.equal(written[0].payload.taskId, first.taskId);

    const after = await h.projectionStore.get(SUBJECT);
    assert.equal(after.holder, CAT, 'newer hold keeps its holder');
    assert.notEqual(after.state, 'resolved', 'retiring an old wake must not resolve the newer active hold');
  });

  test('a retired terminal survives restart and stays idempotent', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });

    h.setLatest('inv-1');
    const before = await h.service.complete(
      auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }),
      'handled',
    );
    assert.equal(before.retired, true);

    // Restart: nothing in memory, only the durable custody log.
    const after = await h
      .restartService()
      .complete(auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }), 'handled');
    assert.equal(after.outcome, 'replayed');
    assert.equal(after.retired, true, 'the retired plane is reconstructed from the event, not from memory');
    assert.equal((await dispositionEvents(h)).length, 1, 'restart must not append a duplicate terminal');
  });

  test('the fix does not weaken fail-closed: a live wake still blocks and a forged one still rejects', async () => {
    const h = await harness();
    const live = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    // A genuinely live wake is still a real obligation that blocks the turn.
    const opened = await h.gate.open(holdWake({ sourceMessageId: live.stored.id, taskId: live.taskId }));
    assert.equal(opened.state, 'covered_active');
    assert.equal((await h.gate.close(opened)).shouldBlock, true, 'live obligations must still block');

    // Identity mismatches stay non-negotiable even on the new terminal path.
    h.tasks.get(live.taskId).params.holdLifecycle.managedCommand.state = 'consumed';
    h.tasks.get(live.taskId).params.holdLifecycle.managedCommand.messageId = 'someone-elses-message';
    await assert.rejects(
      () => h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: live.stored.id }), 'handled'),
      (error) => error.code === 'managed_hold_disposition_task_mismatch',
      'a terminal carrier must not become a bypass for identity checks',
    );
    assert.equal((await dispositionEvents(h)).length, 0);
  });

  // ── Sol REQUEST_CHANGES P1: a terminal command carrier must NOT by itself make
  // the disposition subject-inert. If nothing superseded the wake, it is still the
  // subject's live wake and disposing it must actually resolve the ball.
  test('a terminal task with no successor resolves the subject instead of leaking active state', async () => {
    const h = await harness();
    const { stored, taskId } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    h.tasks.get(taskId).params.holdLifecycle.managedCommand.state = 'consumed';

    const result = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');

    assert.equal(result.retired, false, 'a terminal carrier alone is not a supersession');
    const projection = await h.projectionStore.get(SUBJECT);
    assert.equal(projection.state, 'resolved', 'the exact live wake must reach subject terminal, not stay active');
  });

  test('a terminal task WITH a newer hold retires and leaves the newer custody untouched', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    h.tasks.get(first.taskId).params.holdLifecycle.managedCommand.state = 'consumed';
    await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });
    const beforeHeldUntil = (await h.projectionStore.get(SUBJECT)).heldUntil;

    h.setLatest('inv-1');
    const result = await h.service.complete(
      auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }),
      'handled',
    );

    assert.equal(result.retired, true);
    const projection = await h.projectionStore.get(SUBJECT);
    assert.notEqual(projection.state, 'resolved');
    assert.equal(projection.holder, CAT);
    assert.equal(projection.heldUntil, beforeHeldUntil, 'the newer hold window is untouched');
  });

  test('the same invocation repairs a receipt failure without a second terminal', async () => {
    const h = await harness();
    const { stored } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    h.failReceiptOnce();
    await assert.rejects(
      () => h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled'),
      'the receipt failure must surface, leaving the durable event in place',
    );
    assert.equal((await dispositionEvents(h)).length, 1, 'the custody terminal is already durable');

    const retry = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');

    assert.equal(retry.outcome, 'replayed');
    assert.equal((await dispositionEvents(h)).length, 1, 'exactly one terminal event for one wake');
    assert.equal(h.messageStore.getById(stored.id).deliveryStatus, 'delivered');
    assert.equal((await h.queue.getDurableEntry(THREAD, queueEntryId(stored.id, CAT))).status, 'terminal');
  });

  test('the same invocation repairs a retired wake receipt without touching the newer hold', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });

    h.setLatest('inv-1');
    h.failReceiptOnce();
    await assert.rejects(() =>
      h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }), 'handled'),
    );
    assert.equal((await dispositionEvents(h)).length, 1);

    const retry = await h.service.complete(
      auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }),
      'handled',
    );

    assert.equal(retry.outcome, 'replayed');
    assert.equal(retry.retired, true);
    assert.equal((await dispositionEvents(h)).length, 1, '#1366 AC: duplicate disposition creates no duplicate event');
    const projection = await h.projectionStore.get(SUBJECT);
    assert.notEqual(projection.state, 'resolved', 'the newer hold is still untouched');
  });

  test('the stop gate recognizes an existing terminal while the receipt is repaired', async () => {
    const h = await harness();
    const { stored, taskId } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    h.failReceiptOnce();
    await assert.rejects(() =>
      h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled'),
    );
    assert.equal((await dispositionEvents(h)).length, 1);
    assert.equal((await h.projectionStore.get(SUBJECT)).state, 'resolved');

    // Production order: the route opens the projection BEFORE the tool runs.
    const opened = await h.gate.open(holdWake({ sourceMessageId: stored.id, taskId }));
    const retry = await h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled');
    const decision = await h.gate.close(opened);

    assert.equal(retry.outcome, 'replayed');
    assert.notEqual(opened.state, 'unknown_legacy', 'an already-terminal wake is not unknown legacy');
    assert.equal(decision.shouldBlock, false, 'no managed_hold_disposition_missing for a settled wake');
    assert.equal((await dispositionEvents(h)).length, 1);
  });

  test('a successor invocation cannot steal a processing receipt from its exposed invocation', async () => {
    const h = await harness();
    const first = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });
    await h.deliverWake({ taskId: 'task-2', invocationId: 'inv-2', at: 50_000 });

    h.setLatest('inv-1');
    h.failReceiptOnce();
    await assert.rejects(() =>
      h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: first.stored.id }), 'handled'),
    );

    h.setLatest('inv-3');
    await assert.rejects(
      () => h.service.complete(auth({ invocationId: 'inv-3', sourceMessageId: first.stored.id }), 'handled'),
      (error) => error.code === 'managed_hold_receipt_carrier_mismatch',
    );
    assert.equal((await dispositionEvents(h)).length, 1);
    assert.notEqual((await h.projectionStore.get(SUBJECT)).state, 'resolved', 'newer hold untouched');
  });

  test('two conflicting dispositions inside ONE invocation still linearize to one winner', async () => {
    const h = await harness();
    const { stored } = await h.deliverWake({ taskId: 'task-1', invocationId: 'inv-1', at: 2_000 });

    const results = await Promise.allSettled([
      h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'handled'),
      h.service.complete(auth({ invocationId: 'inv-1', sourceMessageId: stored.id }), 'completed'),
    ]);

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'same-invocation conflict rejects a loser');
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal((await dispositionEvents(h)).length, 1);
  });
});
