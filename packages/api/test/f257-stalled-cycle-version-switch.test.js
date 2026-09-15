// F257: an operator version transition (switch or create) is the cat-free exit
// from a stalled evaluation cycle. It terminates the cycle with
// manual-version-switch provenance, keeps the frozen evaluation window on the
// archived record, and opens the next cycle at the transition timestamp.
// In-flight statuses (requested / retriggered / written) keep blocking it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalog, FakeRedis, stalledRecord } from './f257-stalled-cycle-fixture.js';

const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { CycleTriggerChecker } = await import('../dist/infrastructure/harness-eval/evaluation/CycleTriggerChecker.js');
const { ManualVersionCycleService } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ManualVersionCycleService.js'
);

describe('F257 stalled cycle exits: operator version transition', () => {
  function switchHarness() {
    const redis = new FakeRedis();
    const store = new CycleRecordStore(redis);
    const checker = new CycleTriggerChecker({
      catalog,
      cycles: store,
      traces: {
        async ensureOwnerEpisodeBackfilled() {},
        async getEpisodeByInvocationId() {
          return null;
        },
        async countOwnerWindow() {
          return 0;
        },
        async earliestOwnerEpisode() {
          return null;
        },
      },
      annotations: {
        async queryMetricWindow() {
          return [];
        },
      },
      resolveVersion: () => ({ version: 'v1', versionContentRef: 'hooks:D1@1' }),
    });
    let activeVersion = 1;
    const service = new ManualVersionCycleService({
      runtime: {
        catalog,
        cycles: store,
        cycleChecker: checker,
        async resolveVersion() {
          return { version: 'v2', versionContentRef: 'hooks:D1@2' };
        },
        async resolveSegmentVersion(ref) {
          return Number(ref.match(/@([0-9]+)$/)?.[1] ?? 0);
        },
      },
      overrideStore: {
        async getActiveVersion() {
          return activeVersion;
        },
        async activateVersion(_segmentId, version) {
          activeVersion = version;
        },
        async hasVersion() {
          return true;
        },
        async setContentOverride() {
          activeVersion = 2;
        },
      },
      async refreshOverrideSnapshot() {},
      now: () => 1_500,
    });
    return { store, service, activeVersion: () => activeVersion };
  }

  test('switching the version terminates a stalled cycle and keeps its frozen evaluation window', async () => {
    const { store, service, activeVersion } = switchHarness();
    const stalled = await stalledRecord(store);

    const switched = await service.switch({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      targetVersion: 2,
      actorId: 'owner-1',
      reason: '评估停滞，切到 v2 继续',
    });

    assert.equal(activeVersion(), 2);
    assert.equal(switched.archivedCycleId, stalled.cycleId);
    const archived = await store.historyCycle('owner-1', 'obj', stalled.cycleId);
    assert.equal(archived.evalStatus, 'stalled', 'the archived record keeps the honest terminal status');
    assert.deepEqual(archived.windows, [{ start: 0, end: 1_000 }], 'the frozen evaluation window is preserved');
    assert.equal(archived.stalledAt, 1_200);
    assert.equal(archived.cycleEnd, 1_500);
    assert.equal(archived.closedAt, 1_500);
    assert.equal(archived.termination.kind, 'manual-version-switch');
    assert.equal(archived.termination.at, 1_500);
    assert.equal(switched.currentCycle.evalStatus, 'idle');
    assert.equal(switched.currentCycle.cycleStart, 1_500);
    assert.equal(switched.currentCycle.versionContentRef, 'hooks:D1@2');
    assert.deepEqual(switched.currentCycle.carryoverWindows, [
      {
        start: 0,
        end: 1_500,
        provenance: {
          kind: 'manual-version-switch',
          sourceCycleId: stalled.cycleId,
          sourceVersion: 'v1',
          sourceVersionContentRef: 'hooks:D1@1',
          sourceSegmentId: 'D1',
          sourceSegmentVersion: 1,
        },
      },
    ]);
  });

  test('creating a version from a stalled cycle goes through the same termination', async () => {
    const { store, service } = switchHarness();
    const stalled = await stalledRecord(store);
    const created = await service.create({
      ownerUserId: 'owner-1',
      segmentId: 'D1',
      content: 'edited {{X}}',
      baseVersion: 1,
      expectedActiveVersion: 1,
      actorId: 'owner-1',
      reason: '评估停滞，基于 v1 产生新版本',
    });
    assert.equal(created.archivedCycleId, stalled.cycleId);
    assert.equal((await store.historyCycle('owner-1', 'obj', stalled.cycleId)).termination.baseVersion, 1);
    assert.equal(created.currentCycle.evalStatus, 'idle');
  });

  test('an evaluation that is still in flight keeps blocking the operator transition', async () => {
    const { store, service, activeVersion } = switchHarness();
    const idle = await store.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
    const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
    assert.equal(await store.request(idle, requested), true);
    for (const status of ['requested', 'retriggered', 'written']) {
      const current = await store.current('owner-1', 'obj');
      if (current.evalStatus !== status)
        assert.equal(await store.transition(current, { ...current, evalStatus: status }), true);
      await assert.rejects(
        service.switch({
          ownerUserId: 'owner-1',
          segmentId: 'D1',
          targetVersion: 2,
          actorId: 'owner-1',
          reason: 'wait',
        }),
        /manual_version_switch_evaluation_in_progress/,
      );
    }
    assert.equal(activeVersion(), 1, 'a blocked switch never mutates the active version');
  });
});
