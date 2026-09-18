// F257: a writeback clock measures the time an evaluator had to answer. A wake
// that is still waiting in the invocation queue behind an active invocation
// has given the evaluator no time at all, so it must not start that clock.
// Production 2026-09-15 (S13): the only retrigger was enqueued behind a silent
// evaluator invocation at 11:54, the second 30-minute window ran anyway, and the
// cycle was declared stalled at 12:35 — 58 minutes before the retrigger even ran.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalog, FakeRedis, FakeThreadStore, principal, submission, trace } from './f257-stalled-cycle-fixture.js';

const { CycleEvaluationCoordinator, CYCLE_WRITEBACK_TIMEOUT_MS: T } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js'
);
const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');

/** A requested cycle whose wakes answer with a scripted outcome and whose queue state is controllable. */
async function harness({ outcomes }) {
  const redis = new FakeRedis();
  const cycles = new CycleRecordStore(redis);
  const idle = await cycles.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
  const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
  assert.equal(await cycles.request(idle, requested), true);
  const traces = [trace('inv-1', 500)];
  const deliveries = [];
  const deliveredByKey = new Map();
  const queued = new Set();
  const clock = { now: 100 };
  const scripted = [...outcomes];
  const coordinator = new CycleEvaluationCoordinator({
    runtime: {
      catalog,
      cycles,
      annotations: {
        async queryMetricWindow() {
          return [];
        },
      },
      traces: {
        async ownerInvocationIds() {
          return traces.map((episode) => episode.terminal.invocationId);
        },
        async getEpisodeByInvocationId(id) {
          return traces.find((e) => e.terminal.invocationId === id) ?? null;
        },
      },
      cycleChecker: { setRequestedHandler() {} },
    },
    threadStore: new FakeThreadStore(),
    messageStore: {
      async getByIds() {
        return [];
      },
    },
    async deliver(input) {
      const existing = deliveredByKey.get(input.idempotencyKey);
      if (existing) return existing;
      const id = `message-${deliveries.length + 1}`;
      deliveries.push({ id, ...input });
      deliveredByKey.set(input.idempotencyKey, id);
      return id;
    },
    getInvokeTrigger: () => ({
      async trigger(_threadId, _catId, _userId, _reason, messageId) {
        const outcome = scripted.shift() ?? 'dispatched';
        if (outcome === 'enqueued') queued.add(messageId);
        return outcome;
      },
    }),
    isWakeQueued: (_threadId, messageId) => queued.has(messageId),
    getDefaultCatId: () => 'cat-default',
    now: () => clock.now,
  });
  const count = (word) => deliveries.filter((item) => item.content.includes(word)).length;
  const current = () => cycles.current('owner-1', 'obj');
  return { cycles, coordinator, deliveries, queued, clock, count, current };
}

describe('F257 cycle wake liveness: a queued wake starts no writeback clock', () => {
  test('a retrigger queued behind a running invocation cannot stall the cycle until it is dispatched', async () => {
    const h = await harness({ outcomes: ['dispatched', 'enqueued'] });
    await h.coordinator.reconcileKnownCycles(100);
    const assigned = await h.current();
    assert.equal(assigned.pendingWakeMessageId, undefined, 'a dispatched assignment is not pending');

    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + T);
    const retriggered = await h.current();
    assert.equal(retriggered.evalStatus, 'retriggered');
    assert.equal(retriggered.pendingWakeMessageId, retriggered.retriggerMessageId, 'the queued retrigger is marked');

    // The original invocation stays active for hours: the retrigger never got its turn.
    await h.coordinator.reconcileKnownCycles(retriggered.retriggeredAt + T);
    await h.coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 5 * T);
    assert.equal((await h.current()).evalStatus, 'retriggered', 'a queued retrigger is not a failed retrigger');
    assert.equal(h.count('Stalled'), 0);

    // The queue dispatches it: the second window starts when the evaluator actually got the wake.
    h.queued.clear();
    const dispatchedAt = retriggered.retriggeredAt + 6 * T;
    await h.coordinator.reconcileKnownCycles(dispatchedAt);
    const running = await h.current();
    assert.equal(running.evalStatus, 'retriggered');
    assert.equal(running.pendingWakeMessageId, undefined);
    assert.equal(running.retriggeredAt, dispatchedAt, 'the writeback window is restamped at dispatch');

    await h.coordinator.reconcileKnownCycles(dispatchedAt + T - 1);
    assert.equal((await h.current()).evalStatus, 'retriggered');
    await h.coordinator.reconcileKnownCycles(dispatchedAt + T);
    await h.coordinator.reconcileKnownCycles(dispatchedAt + 3 * T);
    assert.equal((await h.current()).evalStatus, 'stalled');
    assert.equal(h.count('Stalled'), 1, 'exactly one stall alert');
    assert.equal(h.count('Retrigger'), 1, 'exactly one retrigger');
  });

  test('an assignment queued behind a running invocation starts no retrigger clock either', async () => {
    const h = await harness({ outcomes: ['enqueued', 'dispatched'] });
    await h.coordinator.reconcileKnownCycles(100);
    const assigned = await h.current();
    assert.equal(assigned.pendingWakeMessageId, assigned.assignmentMessageId);

    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + 4 * T);
    assert.equal(h.count('Retrigger'), 0, 'the evaluator has not even received the assignment');
    assert.equal((await h.current()).evalStatus, 'requested');

    h.queued.clear();
    const dispatchedAt = assigned.assignedAt + 5 * T;
    await h.coordinator.reconcileKnownCycles(dispatchedAt);
    assert.equal((await h.current()).assignedAt, dispatchedAt);
    assert.equal(h.count('Retrigger'), 0);
    await h.coordinator.reconcileKnownCycles(dispatchedAt + T);
    assert.equal(h.count('Retrigger'), 1);
    assert.equal((await h.current()).evalStatus, 'retriggered');
  });

  test('a writeback that lands while the retrigger is still queued wins, and the late dispatch changes nothing', async () => {
    const h = await harness({ outcomes: ['dispatched', 'enqueued'] });
    await h.coordinator.reconcileKnownCycles(100);
    const assigned = await h.current();
    await h.coordinator.reconcileKnownCycles(assigned.assignedAt + T);
    const retriggered = await h.current();
    assert.ok(retriggered.pendingWakeMessageId);

    // The original, slow invocation finally writes back.
    const result = await h.coordinator.submitEvaluation(principal, { ...submission, cycleId: retriggered.cycleId });
    assert.equal(result.outcome, 'written');
    const written = await h.current();
    assert.equal(written.evalStatus, 'written');
    assert.equal(written.pendingWakeMessageId, undefined, 'a written cycle has no pending wake');

    // The queued retrigger is dispatched afterwards; reconciliation must not reopen or restamp anything.
    h.queued.clear();
    await h.coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 10 * T);
    assert.deepEqual(await h.current(), written);
    assert.equal(h.count('Stalled'), 0);
  });
});
