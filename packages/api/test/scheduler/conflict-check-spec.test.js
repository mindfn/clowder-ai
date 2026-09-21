import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');

/*
 * #1392 R5: a delivery carries the outcome it delivered, and only a matched conflict may drive the
 * auto-resolver. These cases model exactly that delivery, so they still exercise the F140 path.
 *
 * F117 Phase I: these cases used to observe an injected `invokeTrigger` — a seam no GitHub factory
 * ever wired (`github-schedule-factories.ts` passes taskStore/checkMergeable/conflictRouter/
 * autoExecutor/log and nothing else). So they described a configuration production never ran, while
 * the call that actually wakes the owner went unobserved. They now observe the real seam:
 * `conflictRouter.route` admits Message + Queue in one transaction, and THAT admission is the wake.
 */
const conflictMatchedOutcome = {
  v: 1,
  outcomeId: 'wait:pr:owner/repo#7:g1:matched',
  generation: 1,
  subjectRef: 'pr:owner/repo#7',
  ownerFence: { kind: 'containing_task', generation: 1 },
  reason: 'matched',
  at: 1000,
  delivery: 'delivered',
  matched: [{ kind: 'pr_became_conflicting', delta: 'mergeState MERGEABLE → CONFLICTING' }],
};

const CONFLICT_WORK_ITEM = {
  signal: { repoFullName: 'owner/repo', prNumber: 7, headSha: 'aaa', mergeState: 'CONFLICTING' },
  task: { userId: 'user_1' },
};

describe('conflict scheduler F280 adapter', () => {
  test('collects merge state for active PR tasks', async () => {
    const taskStore = new TaskStore();
    await taskStore.create({
      kind: 'pr_tracking',
      subjectKey: 'pr:owner/repo#7',
      threadId: 'thread_1',
      title: 'PR wait',
      ownerCatId: 'codex-sol',
      why: 'test',
      createdBy: 'codex-sol',
      userId: 'user_1',
    });
    const spec = createConflictCheckTaskSpec({
      taskStore,
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'aaa' }),
      conflictRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      log: { info() {}, warn() {}, error() {} },
    });
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.signal.mergeState, 'MERGEABLE');
  });

  test('attempts no remediation when the typed wait remains state-only', async () => {
    const wakes = [];
    const resolves = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: {
        route: async (signal) => {
          wakes.push(signal);
          return { kind: 'skipped', reason: 'predicates_not_matched' };
        },
      },
      autoExecutor: { resolve: async () => resolves.push('resolve') },
      log: { info() {}, warn() {}, error() {} },
    });
    await spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', {});

    // A skipped route admitted nothing, so there is no wake and nothing may touch the repository.
    assert.equal(wakes.length, 1, 'route is consulted exactly once');
    assert.equal(resolves.length, 0, 'an unmatched wait grants no repository mandate');
  });

  test('a durable conflict admission survives a timeout that aborts right after it', async () => {
    const controller = new AbortController();
    const wakes = [];
    const resolves = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: {
        route: async (signal) => {
          wakes.push(signal);
          controller.abort(new DOMException('scheduler timeout', 'AbortError'));
          return {
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg-conflict-1',
            content: 'conflict detected',
            outcome: conflictMatchedOutcome,
          };
        },
      },
      autoExecutor: { resolve: async () => resolves.push('resolve') },
      log: { info() {}, warn() {}, error() {} },
    });

    await assert.doesNotReject(() =>
      spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', { signal: controller.signal }),
    );

    // The wake already committed inside `route`. A late abort must not turn that durable admission
    // into a thrown run — the owner is awake and the scheduler has nothing left to undo.
    assert.equal(wakes.length, 1, 'a durable conflict admission happens exactly once');
    assert.equal(resolves.length, 0, 'an aborted run must not start optional repository work');
  });

  test('cancelled optional remediation does not retract the already-admitted wake', async () => {
    const controller = new AbortController();
    const wakes = [];
    const resolves = [];
    const spec = createConflictCheckTaskSpec({
      taskStore: new TaskStore(),
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'aaa' }),
      conflictRouter: {
        route: async (signal) => {
          wakes.push(signal);
          return {
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg-conflict-2',
            content: 'conflict detected',
            outcome: conflictMatchedOutcome,
          };
        },
      },
      autoExecutor: {
        resolve: async () => {
          resolves.push('resolve');
          controller.abort(new DOMException('scheduler timeout', 'AbortError'));
          throw controller.signal.reason;
        },
      },
      log: { info() {}, warn() {}, error() {} },
    });

    await assert.doesNotReject(() =>
      spec.run.execute(CONFLICT_WORK_ITEM, 'pr:owner/repo#7', { signal: controller.signal }),
    );

    assert.equal(wakes.length, 1, 'the wake stands on its own admission');
    assert.equal(resolves.length, 1, 'remediation was attempted once and then cancelled');
  });
});
