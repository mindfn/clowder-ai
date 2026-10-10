import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { executeTaskPipeline } = await import('../../dist/infrastructure/scheduler/execute-pipeline.js');

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { createCiCdCheckTaskSpec } = await import('../../dist/infrastructure/email/CiCdCheckTaskSpec.js');

async function trackedTask(store) {
  return store.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#7',
    threadId: 'thread_1',
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
    automationState: {
      await: {
        v: 1,
        generation: 1,
        subjectRef: 'pr:owner/repo#7',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { capturedAt: 100, headSha: 'aaa' },
        continuation: {
          when: [{ kind: 'pr_ci_terminal' }],
          // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
          then: 'continue',
        },
        expiresAt: 10_000,
        createdAt: 100,
      },
    },
  });
}

async function trackedTaskFor(store, prNumber) {
  return store.create({
    kind: 'pr_tracking',
    subjectKey: `pr:owner/repo#${prNumber}`,
    threadId: `thread_${prNumber}`,
    title: 'PR wait',
    ownerCatId: 'codex-sol',
    why: 'test',
    createdBy: 'codex-sol',
    userId: 'user_1',
  });
}

describe('CI scheduler F280 adapter', () => {
  test('tick-level bulk reads are not owned by the first work item cancellation signal', async () => {
    const taskStore = new TaskStore();
    await Promise.all([7, 8, 9].map((number) => trackedTaskFor(taskStore, number)));
    const batchSignals = [];
    const routed = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll.prNumber);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
      fetchPrStatuses: async (targets, signal) => {
        batchSignals.push(signal);
        signal?.throwIfAborted();
        return new Map(
          targets.map((target) => [
            `${target.repoFullName}#${target.prNumber}`,
            {
              ...target,
              headSha: String(target.prNumber),
              prState: 'open',
              aggregateBucket: 'pending',
              checks: [],
            },
          ]),
        );
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const gate = await spec.admission.gate();
    const firstController = new AbortController();
    firstController.abort(new Error('first item timed out'));
    await assert.rejects(
      spec.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
        assignedCatId: null,
        signal: firstController.signal,
      }),
      /first item timed out/,
    );

    await spec.run.execute(gate.workItems[1].signal, gate.workItems[1].subjectKey, {
      assignedCatId: null,
      signal: new AbortController().signal,
    });

    assert.deepEqual(batchSignals, [undefined]);
    assert.deepEqual(routed, [8]);
  });

  test('one tick shares one bulk GitHub read across every tracked PR', async () => {
    const taskStore = new TaskStore();
    const tasks = await Promise.all([7, 8, 9].map((number) => trackedTaskFor(taskStore, number)));
    const batchCalls = [];
    const routed = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll.prNumber);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
      fetchPrStatuses: async (targets) => {
        batchCalls.push(targets);
        return new Map(
          targets.map((target) => [
            `${target.repoFullName}#${target.prNumber}`,
            {
              ...target,
              headSha: String(target.prNumber),
              prState: 'open',
              aggregateBucket: 'pending',
              checks: [],
            },
          ]),
        );
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    for (const item of gate.workItems) await spec.run.execute(item.signal, item.subjectKey, {});

    assert.equal(batchCalls.length, 1);
    assert.deepEqual(
      batchCalls[0].map((target) => target.prNumber),
      [7, 8, 9],
    );
    assert.deepEqual(routed, [7, 8, 9]);
    assert.equal(tasks.length, 3);
  });

  test('a slow failed PR times out locally while its sibling advances through the real pipeline', async () => {
    const taskStore = new TaskStore();
    await trackedTaskFor(taskStore, 8);
    await trackedTaskFor(taskStore, 7);
    const routed = [];
    const rows = [];
    const diagnosticSignals = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
      fetchPrStatuses: async (targets) =>
        new Map(
          targets.map((target) => [
            `${target.repoFullName}#${target.prNumber}`,
            {
              ...target,
              headSha: `${target.prNumber}-exact`,
              prState: 'open',
              aggregateBucket: target.prNumber === 8 ? 'fail' : 'pass',
              checks: [],
            },
          ]),
        ),
      enrichPrStatus: async (poll, signal) => {
        if (poll.aggregateBucket !== 'fail') return poll;
        diagnosticSignals.push(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
      log: { info() {}, warn() {}, error() {} },
    });
    // Shorten only the existing scheduler timeout in this isolated fixture.
    spec.run.timeoutMs = 20;
    await executeTaskPipeline({
      task: spec,
      ledger: { record: (row) => rows.push(row) },
      logger: { info() {}, error() {} },
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
    });
    assert.equal(diagnosticSignals.length, 1);
    assert.equal(diagnosticSignals[0].aborted, true);
    assert.deepEqual(
      routed.map((poll) => [poll.prNumber, poll.headSha, poll.aggregateBucket]),
      [[7, '7-exact', 'pass']],
    );
    assert.deepEqual(
      rows.map((row) => [row.subject_key, row.outcome]),
      [
        ['pr:owner/repo#8', 'RUN_FAILED'],
        ['pr:owner/repo#7', 'RUN_DELIVERED'],
      ],
    );
  });

  test('mixed batch timeout still persists the successful wait and admits one exact wake across repeated ticks', async () => {
    const { connectorDeliveryHarness } = await import('../helpers/connector-delivery-harness.js');
    const { MemoryWaitLifecycleEventLog } = await import('../../dist/domains/ball-custody/WaitLifecycleEventLog.js');
    const { GitHubWaitLifecycleService } = await import(
      '../../dist/domains/github-signals/GitHubWaitLifecycleService.js'
    );
    const { CiCdRouter } = await import('../../dist/infrastructure/email/CiCdRouter.js');
    const taskStore = new TaskStore();
    await trackedTaskFor(taskStore, 8);
    const task = await trackedTask(taskStore);
    await taskStore.patchAutomationState(task.id, {
      ci: { headSha: 'aaa', lastFingerprint: 'aaa:pending', lastBucket: 'pending' },
      await: {
        ...task.automationState.await,
        baseline: { capturedAt: 100, headSha: 'aaa', ci: { bucket: 'pending', fingerprint: 'aaa:pending' } },
      },
    });
    const harness = connectorDeliveryHarness();
    const log = { info() {}, warn() {}, error() {} };
    const lifecycle = new GitHubWaitLifecycleService({
      taskStore,
      deliveryDeps: harness.deliveryDeps,
      eventLog: new MemoryWaitLifecycleEventLog(),
      now: () => 500,
      log,
    });
    const router = new CiCdRouter({
      taskStore,
      deliveryDeps: harness.deliveryDeps,
      waitLifecycle: lifecycle,
      log,
      now: () => 500,
    });
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: router,
      log,
      fetchPrStatuses: async (targets) =>
        new Map(
          targets.map((target) => [
            `${target.repoFullName}#${target.prNumber}`,
            {
              ...target,
              headSha: target.prNumber === 7 ? 'aaa' : 'failed-exact',
              prState: 'open',
              checkRollup: 'present',
              aggregateBucket: target.prNumber === 8 ? 'fail' : 'pass',
              checks: [{ name: 'gate', bucket: target.prNumber === 8 ? 'fail' : 'pass' }],
            },
          ]),
        ),
      enrichPrStatus: async (poll, signal) =>
        poll.aggregateBucket !== 'fail'
          ? poll
          : new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            ),
    });
    spec.run.timeoutMs = 20;
    const context = {
      task: spec,
      ledger: { record() {} },
      logger: log,
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
    };
    await executeTaskPipeline(context);
    const first = await taskStore.get(task.id);
    assert.equal(first.automationState.ci.lastBucket, 'pass');
    assert.equal(first.automationState.ci.headSha, 'aaa');
    assert.equal(first.automationState.waitOutcome.delivery, 'delivered');
    const generation = first.automationState.await.generation;
    assert.equal(generation, 2);
    assert.equal(harness.deliveries('thread_1').length, 1);
    assert.equal(harness.wakes.length, 1);
    await executeTaskPipeline(context);
    assert.equal(harness.deliveries('thread_1').length, 1, 'same fact must not replay a notification');
    assert.equal((await taskStore.get(task.id)).automationState.await.generation, generation);
  });

  test('PR-local diagnostics reach routing with the same exact HEAD and typed failure evidence', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTaskFor(taskStore, 8);
    const original = {
      repoFullName: 'owner/repo',
      prNumber: 8,
      headSha: 'failed-exact',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [],
    };
    const controller = new AbortController();
    const routed = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll);
          return { kind: 'deduped', reason: 'existing generation' };
        },
      },
      fetchPrStatuses: async () => new Map([['owner/repo#8', original]]),
      enrichPrStatus: async (poll, signal) => {
        assert.equal(signal, controller.signal);
        assert.equal(poll, original);
        return {
          ...poll,
          checks: [{ name: 'required', bucket: 'fail', executionFailure: 'billing_spending_limit_zero_step' }],
        };
      },
      log: { info() {}, warn() {}, error() {} },
    });
    const gate = await spec.admission.gate();
    await spec.run.execute(gate.workItems[0].signal, task.subjectKey, { signal: controller.signal });
    assert.equal(routed[0].headSha, 'failed-exact');
    assert.equal(routed[0].checks[0].executionFailure, 'billing_spending_limit_zero_step');
    assert.equal(original.checks.length, 0, 'diagnostics do not mutate the sibling-shared snapshot');
  });

  test('gate emits one work item per active PR wait', async () => {
    const taskStore = new TaskStore();
    await trackedTask(taskStore);
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaa',
        prState: 'open',
        aggregateBucket: 'pending',
        checks: [],
      }),
      log: { info() {}, warn() {}, error() {} },
    });
    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
  });

  test('gate keeps a terminal task reachable until durable world-truth effects complete', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTask(taskStore);
    await taskStore.update(task.id, { status: 'done' });
    await taskStore.patchAutomationState(task.id, { ci: { prState: 'merged' } });
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatus: async () => null,
      log: { info() {}, warn() {}, error() {} },
    });

    assert.equal((await spec.admission.gate()).run, true);

    await taskStore.patchAutomationState(task.id, {
      ci: { terminalEffects: { prState: 'merged', completedAt: 500 } },
    });
    assert.equal((await spec.admission.gate()).run, false);
  });

  test('gate keeps a completed wait collectable while a configured external case is still open', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTask(taskStore);
    await taskStore.update(task.id, { status: 'done' });
    const continuationChecks = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatus: async () => null,
      continueDoneTracking: async (repoFullName, prNumber) => {
        continuationChecks.push({ repoFullName, prNumber });
        return true;
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.equal(gate.workItems.length, 1);
    assert.deepEqual(continuationChecks, [{ repoFullName: 'owner/repo', prNumber: 7 }]);
  });

  test('only a notified typed outcome invokes the owner', async () => {
    const taskStore = new TaskStore();
    const task = await trackedTask(taskStore);
    const calls = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (...args) => {
          calls.push(args);
          return {
            kind: 'notified',
            threadId: 'thread_1',
            catId: 'codex-sol',
            messageId: 'msg_1',
            bucket: 'pass',
            content: 'compact wait',
          };
        },
      },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaa',
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      }),
      log: { info() {}, warn() {}, error() {} },
    });
    await spec.run.execute({ task, repoFullName: 'owner/repo', prNumber: 7 }, task.subjectKey, {});
    // Routing IS admission: one confirmed route is one owner wake. The old trigger `reason`
    // policy was never read by production, so the observable fact is the route itself.
    assert.equal(calls.length, 1);
  });
});
