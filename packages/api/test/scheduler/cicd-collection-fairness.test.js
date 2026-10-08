import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createCiCdCheckTaskSpec } from '../../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';

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

describe('bounded and fair CI collection', () => {
  for (const candidateCount of [21, 40, 45, 60, 61, 80, 100, 120, 125, 140, 180, 200, 330]) {
    test(`eventually routes all ${candidateCount} PRs despite a persistently failed first batch`, async () => {
      const taskStore = new TaskStore();
      await Promise.all(Array.from({ length: candidateCount }, (_, i) => trackedTaskFor(taskStore, i + 1)));
      const collected = new Set();
      const outcomes = [];
      const spec = createCiCdCheckTaskSpec({
        taskStore,
        cicdRouter: {
          route: async (poll) => {
            collected.add(poll.prNumber);
            return { kind: 'skipped', reason: 'state-only' };
          },
        },
        fetchPrStatuses: async (targets) => {
          assert.ok(targets.length <= 60, 'rotation must keep the existing admission budget');
          assert.equal(new Set(targets.map((target) => target.prNumber)).size, targets.length);
          return new Map(
            targets.map((target, i) => [
              `${target.repoFullName}#${target.prNumber}`,
              i < 20
                ? null
                : {
                    ...target,
                    headSha: `head-${target.prNumber}`,
                    prState: 'open',
                    aggregateBucket: 'pending',
                    checks: [],
                  },
            ]),
          );
        },
        log: { info() {}, warn() {}, error() {} },
      });
      const maxTicks = candidateCount % 60 === 0 ? (2 * candidateCount) / 60 : candidateCount;
      for (let i = 0; i < maxTicks && collected.size < candidateCount; i++)
        await executeTaskPipeline({
          task: spec,
          ledger: {
            record(entry) {
              outcomes.push(entry);
            },
          },
          logger: { info() {}, error() {} },
          running: new Map(),
          tickCounts: new Map(),
          lastRunAt: new Map(),
        });
      assert.equal(collected.size, candidateCount, 'queried subjects must eventually get successful facts to route');
      assert.ok(
        outcomes.some((entry) => entry.outcome === 'RUN_FAILED'),
        'missing facts still record a failure',
      );
    });
  }
  test('advances both rotations before a tick-level reader throws', async () => {
    const taskStore = new TaskStore();
    await Promise.all(Array.from({ length: 120 }, (_, i) => trackedTaskFor(taskStore, i + 1)));
    const queryOrder = [];
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatuses: async (targets) => {
        queryOrder.push(targets.map((target) => target.prNumber));
        throw new Error('tick-level read unavailable');
      },
      log: { info() {}, warn() {}, error() {} },
    });
    for (let i = 0; i < 4; i++) await assert.rejects(spec.admission.gate(), /tick-level read unavailable/);
    assert.equal(new Set(queryOrder.flat()).size, 120, 'failed reads cannot pin window membership');
    const outsideFirstBatch = new Set(queryOrder.flatMap((targets) => targets.slice(20)));
    assert.equal(outsideFirstBatch.size, 120, 'failed reads cannot pin the same subjects in the first batch');
  });
  test('bounds each tick and rotates collection so late PRs cannot starve', async () => {
    const taskStore = new TaskStore();
    await Promise.all(Array.from({ length: 125 }, (_, i) => trackedTaskFor(taskStore, i + 1)));
    const visited = new Set();
    const spec = createCiCdCheckTaskSpec({
      taskStore,
      cicdRouter: { route: async () => ({ kind: 'skipped', reason: 'state-only' }) },
      fetchPrStatuses: async (targets) => {
        assert.ok(targets.length <= 60, 'one tick must leave room inside the shared admission budget');
        for (const target of targets) visited.add(target.prNumber);
        return new Map(targets.map((target) => [`${target.repoFullName}#${target.prNumber}`, null]));
      },
      log: { info() {}, warn() {}, error() {} },
    });
    for (let i = 0; i < 3; i++) await spec.admission.gate();
    assert.equal(visited.size, 125);
  });
});
