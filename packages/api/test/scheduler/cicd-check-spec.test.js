import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

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
  test('routes healthy facts before failed detail enrichment and records the failed PR for retry', async () => {
    const { executeTaskPipeline } = await import('../../dist/infrastructure/scheduler/execute-pipeline.js');
    const taskStore = new TaskStore();
    await Promise.all([7, 8].map((number) => trackedTaskFor(taskStore, number)));
    const observations = [];
    const rows = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          observations.push(`route-${poll.prNumber}`);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
      fetchPrStatuses: async () =>
        new Map(
          [7, 8].map((prNumber) => [
            `owner/repo#${prNumber}`,
            {
              repoFullName: 'owner/repo',
              prNumber,
              headSha: `head-${prNumber}`,
              prState: 'open',
              aggregateBucket: prNumber === 7 ? 'fail' : 'pass',
              checks: [],
              failureDetailsPending: prNumber === 7,
            },
          ]),
        ),
      enrichFailureDetails: async () => {
        observations.push('detail-7');
        throw new Error('detail collection timeout');
      },
      log: { info() {}, warn() {}, error() {} },
    });
    await executeTaskPipeline({
      task: spec,
      ledger: { record: (row) => rows.push(row) },
      logger: { info() {}, error() {} },
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
    });
    assert.deepEqual(observations, ['route-8', 'detail-7']);
    assert.equal(rows.find((row) => row.subject_key === 'pr:owner/repo#7').outcome, 'RUN_FAILED');
    assert.equal(rows.find((row) => row.subject_key === 'pr:owner/repo#8').outcome, 'RUN_DELIVERED');
  });

  test('records missing CI facts as failed while healthy siblings still route', async () => {
    const { executeTaskPipeline } = await import('../../dist/infrastructure/scheduler/execute-pipeline.js');
    const taskStore = new TaskStore();
    await Promise.all([7, 8].map((number) => trackedTaskFor(taskStore, number)));
    const routed = [];
    const ledger = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: {
        route: async (poll) => {
          routed.push(poll.prNumber);
          return { kind: 'skipped', reason: 'state-only' };
        },
      },
      fetchPrStatuses: async () =>
        new Map([
          ['owner/repo#7', null],
          [
            'owner/repo#8',
            {
              repoFullName: 'owner/repo',
              prNumber: 8,
              headSha: 'head-8',
              prState: 'open',
              aggregateBucket: 'pass',
              checks: [],
            },
          ],
        ]),
      log: { info() {}, warn() {}, error() {} },
    });
    await executeTaskPipeline({
      task: spec,
      ledger: { record: (row) => ledger.push(row) },
      logger: { info() {}, error() {} },
      running: new Map(),
      tickCounts: new Map(),
      lastRunAt: new Map(),
    });
    assert.equal(ledger.find((row) => row.subject_key === 'pr:owner/repo#7')?.outcome, 'RUN_FAILED');
    assert.equal(ledger.find((row) => row.subject_key === 'pr:owner/repo#8')?.outcome, 'RUN_DELIVERED');
    assert.deepEqual(routed, [8]);
  });

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
        route: async () => ({
          kind: 'notified',
          threadId: 'thread_1',
          catId: 'codex-sol',
          messageId: 'msg_1',
          bucket: 'pass',
          content: 'compact wait',
        }),
      },
      fetchPrStatus: async () => ({
        repoFullName: 'owner/repo',
        prNumber: 7,
        headSha: 'aaa',
        prState: 'open',
        aggregateBucket: 'pass',
        checks: [],
      }),
      invokeTrigger: { trigger: async (...args) => calls.push(args) },
      log: { info() {}, warn() {}, error() {} },
    });
    await spec.run.execute({ task, repoFullName: 'owner/repo', prNumber: 7 }, task.subjectKey, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][6].reason, 'github_wait_satisfied');
  });
});
