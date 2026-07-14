/**
 * F257 Phase D — buildVersionChain() unit tests.
 *
 * Red tests for review findings:
 *   P1-1: activeVersion computation wrong (contentVersion=1 maps to manifest v1)
 *   P1-2: eval judgment unconditionally attached to latest epoch
 *   P2-3: no direct tests existed
 *
 * Scenarios from reviewer (terra/codex):
 *   1. Create and activate V2 (first content override)
 *   2. V2 exists but V1 still active (after rollback)
 *   3. Rollback then re-create (V3)
 *   4. Old eval NOT attributed to new version
 *   5. segmentVersion preserved in judgment attachment
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// Helper: create a minimal OverrideChangeEvent for tests
function makeEvent(partial) {
  return {
    eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    hookId: 'S1',
    workspaceId: 'default',
    source: 'operator',
    timestamp: 0,
    actorId: 'user1',
    ...partial,
  };
}

describe('buildVersionChain', () => {
  /** @type {typeof import('../dist/routes/segment-lifeline-chain.js').buildVersionChain} */
  let buildVersionChain;

  test('setup: import chain builder', async () => {
    const mod = await import('../dist/routes/segment-lifeline-chain.js');
    buildVersionChain = mod.buildVersionChain;
    assert.ok(buildVersionChain, 'buildVersionChain exported');
  });

  // ── Baseline ─────────────────────────────────────────────────

  test('manifest-only segment produces single v1 epoch', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain.length, 1);
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].origin, 'manifest');
    assert.equal(chain[0].isActive, true);
    assert.equal(chain[0].status, 'idle');
  });

  // ── P1-1 scenario 1: Create and activate V2 ─────────────────

  test('first content-set creates v2 epoch and marks it active', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain.length, 2, 'should have 2 epochs');
    // V1 = manifest baseline, NOT active
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false, 'v1 should NOT be active when content override exists');
    // V2 = first override, IS active
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, true, 'v2 should be active when contentVersion=1');
  });

  // ── P1-1 scenario 2: V2 exists but V1 still active ──────────

  test('v2 exists but v1 is active after rollback', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null, // rolled back → contentVersion cleared
    });

    assert.equal(chain.length, 2, 'rollback does not remove epoch');
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, true, 'v1 should be active after rollback');
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false, 'v2 should NOT be active after rollback');
  });

  // ── P1-1 scenario 3: Rollback then re-create ────────────────

  test('rollback then new content-set → v3 active, not v2', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1, // contentVersion restarted after rollback+re-create
    });

    assert.equal(chain.length, 3, 'should have 3 epochs');
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false);
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false, 'v2 (old override) should NOT be active');
    assert.equal(chain[2].version, 3);
    assert.equal(chain[2].isActive, true, 'v3 (latest override) should be active');
  });

  // ── P1-2 scenario 4: Old eval NOT on new version ────────────

  test('eval judgment at t=500 is NOT attached to v2 created at t=1000', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 10,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 500, // BEFORE v2 was created at t=1000
        runId: 'run1',
        segmentVersion: 1,
      },
      currentContentVersion: 1,
    });

    // Eval ran at t=500 when only v1 existed → should be on v1
    assert.ok(chain[0].eval, 'v1 should have eval data');
    assert.equal(chain[0].eval.verdict, 'alive');
    // V2 should NOT have eval data (it didn't exist when eval ran)
    assert.equal(chain[1].eval, null, 'v2 should NOT have eval (created after eval ran)');
  });

  test('eval judgment at t=1500 IS attached to v2 created at t=1000', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'dormant',
        injectionCount: 5,
        violationCount: 3,
        correlationConfidence: 'window',
        evaluatedAt: 1500, // AFTER v2 was created at t=1000
        runId: 'run2',
        segmentVersion: 1,
      },
      currentContentVersion: 1,
    });

    // Eval ran at t=1500 when v2 was current → should be on v2
    assert.equal(chain[0].eval, null, 'v1 should NOT have eval');
    assert.ok(chain[1].eval, 'v2 should have eval data');
    assert.equal(chain[1].eval.verdict, 'dormant');
  });

  // ── Observation attachment ───────────────────────────────────

  test('observations are attached to correct epoch by timestamp', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [
        { timestamp: 500, version: null }, // before v2
        { timestamp: 800, version: null }, // before v2
        { timestamp: 1200, version: null }, // after v2
        { timestamp: 1500, version: null }, // after v2
      ],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain[0].tracing?.observationCount, 2, 'v1 should have 2 observations');
    assert.equal(chain[1].tracing?.observationCount, 2, 'v2 should have 2 observations');
  });

  test('observations with explicit contentVersion use timestamp, not version-number match (R2 P1-1)', async () => {
    // Scenario: first content-set creates epoch v2 (chain auto-increments from manifest v1=1).
    // HookRegistry records contentVersion=1 in traces.
    // Old bug: findEpochForObservation matched version=1 → manifest epoch v1 (WRONG).
    // Fix: timestamp-based matching → obs at t=1200 (after v2 created at t=1000) → epoch v2.
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [
        { timestamp: 500, version: 1 }, // before v2 — contentVersion=1, should go to v1 by timestamp
        { timestamp: 1200, version: 1 }, // after v2 — contentVersion=1, MUST go to v2 by timestamp (not v1!)
        { timestamp: 1500, version: 2 }, // after v2 — contentVersion=2 from second implicit trace
      ],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    assert.equal(chain[0].tracing?.observationCount, 1, 'v1 epoch should have 1 observation (t=500)');
    assert.equal(chain[1].tracing?.observationCount, 2, 'v2 epoch should have 2 observations (t=1200 + t=1500)');
  });

  test('activeVersion in chain derives from isActive epoch, not raw contentVersion', async () => {
    // First content-set: chain epoch v2, contentVersion=1. They must not be confused.
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [makeEvent({ action: 'content-set', timestamp: 1000 })],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 1,
    });

    const activeEpoch = chain.find((e) => e.isActive);
    assert.ok(activeEpoch, 'should have an active epoch');
    assert.equal(activeEpoch.version, 2, 'active epoch should be v2 (not contentVersion=1)');
    assert.equal(activeEpoch.origin, 'user-create', 'active epoch should be user-created override');
  });

  // ── Rollback activation timeline (R3 P1-1) ──────────────────

  test('rollback → trace after rollback goes to v1, not v2 (R3 P1-1)', async () => {
    // Terra reproduction: content-set@1000 → rollback@2000 → trace@2100
    // Old bug: startedAt-based matching put trace@2100 on v2 (2100 >= 1000).
    // Fix: activation timeline tracks rollback → v1 active from t=2000.
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [
        { timestamp: 500, version: null }, // v1 active (before content-set)
        { timestamp: 1500, version: null }, // v2 active (between content-set and rollback)
        { timestamp: 2100, version: 1 }, // v1 active (after rollback) — MUST go to v1!
        { timestamp: 3000, version: null }, // v1 active (after rollback)
      ],
      cachedJudgment: null,
      currentContentVersion: null, // rollback clears content version
    });

    assert.equal(chain.length, 2, 'should have v1 + v2 epochs');
    assert.equal(chain[0].tracing?.observationCount, 3, 'v1 should have 3 obs (t=500, t=2100, t=3000)');
    assert.equal(chain[1].tracing?.observationCount, 1, 'v2 should have 1 obs (t=1500 only)');
    assert.equal(chain[0].isActive, true, 'v1 should be active after rollback');
    assert.equal(chain[1].isActive, false, 'v2 should NOT be active after rollback');
  });

  test('rollback → eval after rollback goes to v1, not v2 (R3 P1-1)', async () => {
    // Eval runs at t=2500, after rollback at t=2000.
    // Must attach to v1 (active after rollback), not v2.
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 8,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 2500, // after rollback
        runId: 'run-post-rollback',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    assert.ok(chain[0].eval, 'v1 should have eval (eval ran while v1 active after rollback)');
    assert.equal(chain[0].eval.verdict, 'alive');
    assert.equal(chain[1].eval, null, 'v2 should NOT have eval');
  });

  test('content-set → rollback → content-set: activation timeline tracks re-creation', async () => {
    // v1 → v2@1000 → rollback@2000 → v3@3000
    // trace@2500 (between rollback and v3) → v1
    // trace@3500 (after v3) → v3
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'rollback', timestamp: 2000 }),
        makeEvent({ action: 'content-set', timestamp: 3000 }),
      ],
      observations: [
        { timestamp: 500, version: null }, // v1
        { timestamp: 1500, version: null }, // v2
        { timestamp: 2500, version: null }, // v1 (after rollback)
        { timestamp: 3500, version: null }, // v3
      ],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3, 'should have v1, v2, v3');
    assert.equal(chain[0].tracing?.observationCount, 2, 'v1: t=500 + t=2500');
    assert.equal(chain[1].tracing?.observationCount, 1, 'v2: t=1500');
    assert.equal(chain[2].tracing?.observationCount, 1, 'v3: t=3500');
    assert.equal(chain[2].isActive, true, 'v3 should be active');
  });

  // ── Status derivation ────────────────────────────────────────

  test('epoch with observations derives tracing status', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [{ timestamp: 1000, version: null }],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].status, 'tracing');
  });

  test('alive verdict derives governance-pending status (eval triggers governance)', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'alive',
        injectionCount: 10,
        violationCount: 0,
        correlationConfidence: 'window',
        evaluatedAt: 500,
        runId: 'run1',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    // alive verdict → governance=pending takes priority → governance-pending status
    assert.equal(chain[0].status, 'governance-pending');
  });

  test('retire-candidate verdict derives eval-reject status (no governance)', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      cachedJudgment: {
        segmentId: 'S1',
        verdict: 'retire-candidate',
        injectionCount: 10,
        violationCount: 8,
        correlationConfidence: 'window',
        evaluatedAt: 500,
        runId: 'run1',
        segmentVersion: null,
      },
      currentContentVersion: null,
    });

    assert.equal(chain[0].status, 'eval-reject');
  });

  // ── Governance events ────────────────────────────────────────

  test('enable/disable events become governance events on epoch', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'disable', timestamp: 1000 }),
        makeEvent({ action: 'enable', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: null,
    });

    assert.equal(chain[0].events.length, 2);
    assert.equal(chain[0].events[0].kind, 'eval-reject');
    assert.equal(chain[0].events[1].kind, 'governance-approve');
  });

  // ── Multiple content versions ────────────────────────────────

  test('two content-set events create v1, v2, v3 with v3 active', async () => {
    const chain = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        makeEvent({ action: 'content-set', timestamp: 1000 }),
        makeEvent({ action: 'content-set', timestamp: 2000 }),
      ],
      observations: [],
      cachedJudgment: null,
      currentContentVersion: 2,
    });

    assert.equal(chain.length, 3);
    assert.equal(chain[0].version, 1);
    assert.equal(chain[0].isActive, false);
    assert.equal(chain[1].version, 2);
    assert.equal(chain[1].isActive, false);
    assert.equal(chain[2].version, 3);
    assert.equal(chain[2].isActive, true, 'v3 (latest content-set) should be active');
  });
});
