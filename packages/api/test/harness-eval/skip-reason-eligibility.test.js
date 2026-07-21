/**
 * F257 V2 — skip-reason eligibility registry + escalation filter tests.
 *
 * Sol verdict: dedup_active false-escalation. Sol R1 fixes:
 * P1-1: hard-cap with pure dedup_active must NOT escalate
 * P2-2: classifications match producer semantics (queue_pending removed)
 * P2-3: integration tests include current event in log (production parity)
 * P3-1: deep freeze on entries
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { checkGuardThreshold } from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import { produceHarnessLedgerRunSnapshot } from '../../dist/infrastructure/harness-eval/harness-ledger-snapshot-provider.js';
import {
  isEscalationEligible,
  SKIP_REASON_ELIGIBILITY,
  skipReasonCategory,
} from '../../dist/infrastructure/harness-eval/skip-reason-eligibility.js';
import { createFakeEventSource, rawEvent, T, triggerSuccess } from './_guard-test-helpers.js';

// ---------------------------------------------------------------------------
// 1. Registry unit tests (P2-2 classifications + P3-1 deep freeze)
// ---------------------------------------------------------------------------

describe('skip-reason eligibility registry', () => {
  it('dedup_active is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('dedup_active'), false);
  });

  it('aborted is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('aborted'), false);
  });

  it('depth IS eligible for escalation (chain safety guard)', () => {
    assert.equal(isEscalationEligible('depth'), true);
  });

  it('pingpong_streak IS eligible for escalation', () => {
    assert.equal(isEscalationEligible('pingpong_streak'), true);
  });

  it('unknown reason defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible('some_future_reason'), true);
  });

  it('undefined/missing reason defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible(undefined), true);
  });

  it('empty string defaults to eligible (fail-closed)', () => {
    assert.equal(isEscalationEligible(''), true);
  });

  it('queue_pending is NOT registered (dead letter — no production emit point)', () => {
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'queue_pending'), false);
    // Falls through to unknown → eligible (fail-closed)
    assert.equal(isEscalationEligible('queue_pending'), true);
  });

  it('prototype keys are not eligible entries', () => {
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'toString'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'constructor'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, '__proto__'), false);
  });

  // P3-1: deep freeze
  it('entries are deeply frozen (sol R1 P3-1)', () => {
    const entry = SKIP_REASON_ELIGIBILITY.dedup_active;
    assert.ok(Object.isFrozen(entry), 'entry object must be frozen');
    assert.throws(
      () => {
        /** @type {any} */ (entry).eligible = true;
      },
      TypeError,
      'mutating frozen entry must throw in strict mode',
    );
  });
});

describe('skipReasonCategory (P2-2 producer semantics)', () => {
  it('dedup_active → delivery_dedup', () => {
    assert.equal(skipReasonCategory('dedup_active'), 'delivery_dedup');
  });

  it('depth → safety_guard (chain safety limit, not capacity)', () => {
    assert.equal(skipReasonCategory('depth'), 'safety_guard');
  });

  it('pingpong_streak → safety_guard', () => {
    assert.equal(skipReasonCategory('pingpong_streak'), 'safety_guard');
  });

  it('aborted → abort', () => {
    assert.equal(skipReasonCategory('aborted'), 'abort');
  });

  it('unknown → unknown', () => {
    assert.equal(skipReasonCategory('mystery_reason'), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. Escalation integration — P2-3: current event IN log (production parity)
// ---------------------------------------------------------------------------

describe('escalation eligibility filter — dedup_active (sol verdict, real append)', () => {
  it('3 dedup_active events in log do NOT trigger escalation', async () => {
    // P2-3: current event is INCLUDED in the seeded log (production: append
    // writes to ZSET, then postAppendHook fires with the same event).
    // 3 events with >60s gaps = 3 episodes, all dedup_active → 0 eligible.
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'dedup_active',
    });
    const events = [
      rawEvent({
        timestamp: T,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, false, 'dedup_active must NOT meet threshold');
    assert.equal(result.escalated, false, 'must NOT escalate');
    assert.equal(result.episodeCount, 0, 'eligible episode count must be 0');
    assert.equal(triggerEval.mock.callCount(), 0, 'triggerEval must NOT be called');
  });

  it('3 eligible (depth) events in log DO trigger escalation', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({
        timestamp: T,
        seq: 0,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'eligible events must meet threshold');
    assert.equal(result.escalated, true, 'must escalate');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval must be called once');
  });

  it('mixed: 5 dedup_active + 3 eligible (in log) → DOES escalate', async () => {
    // P2-3: 3rd eligible event IS in the log. In production, append already
    // wrote it before postAppendHook fires. Total eligible episodes = 3.
    const currentEvent = rawEvent({
      timestamp: T + 840_000,
      seq: 7,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_route_decision_skip', normalizedReason: 'dedup_active' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 3,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 480_000,
        seq: 4,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      rawEvent({ timestamp: T + 720_000, seq: 6, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, '3 eligible episodes (depth) meet threshold');
    assert.equal(result.escalated, true, 'must escalate');
    assert.equal(triggerEval.mock.callCount(), 1);
  });

  it('mixed: 5 dedup_active + 2 eligible (in log) → does NOT escalate', async () => {
    // Only 2 eligible episodes — below threshold of 3.
    const currentEvent = rawEvent({
      timestamp: T + 720_000,
      seq: 6,
      guardId: 'a2a_route_decision_skip',
      normalizedReason: 'depth',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_route_decision_skip', normalizedReason: 'dedup_active' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 360_000,
        seq: 3,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({
        timestamp: T + 480_000,
        seq: 4,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.episodeCount, 2, 'only 2 eligible episodes');
    assert.equal(result.thresholdMet, false, 'below threshold');
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 3. P1-1: hard-cap three-state (dedup-only / eligible-only / mixed)
// ---------------------------------------------------------------------------

describe('hard-cap + eligibility filter (sol R1 P1-1)', () => {
  it('10,001 dedup_active events hitting hard cap do NOT escalate', async () => {
    // Pure dedup_active window: episodeCount=0 eligible, truncated=true.
    // P1-1 fix: truncatedAndRelevant = truncated && (episodeCount>0 || !skipped)
    //         = true && (0>0 || !10001) = true && false = false → no escalation.
    const events = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `dedup-cap-${i}`,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[events.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.episodeCount, 0, 'zero eligible episodes');
    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.thresholdMet, false, 'dedup-only cap must NOT meet threshold');
    assert.equal(result.escalated, false, 'must NOT escalate');
    assert.equal(triggerEval.mock.callCount(), 0, 'triggerEval must NOT be called');
  });

  it('10,001 eligible events hitting hard cap DO escalate (existing behavior)', async () => {
    const events = Array.from({ length: 10_001 }, (_, i) =>
      rawEvent({
        timestamp: T + i,
        seq: i,
        eventId: `elig-cap-${i}`,
        guardId: 'hold_ball_rate_limit',
      }),
    );
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(events[events.length - 1], {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.truncated, true, 'hard cap hit');
    assert.equal(result.thresholdMet, true, 'eligible cap → conservative-true');
    assert.equal(result.escalated, true, 'must escalate');
  });
});

// ---------------------------------------------------------------------------
// 4. Non-regression: hold_ball and pingpong still escalate
// ---------------------------------------------------------------------------

describe('escalation non-regression — hold_ball and pingpong', () => {
  it('hold_ball_rate_limit events still escalate', async () => {
    const currentEvent = rawEvent({ timestamp: T + 240_000, seq: 2, guardId: 'hold_ball_rate_limit' });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'hold_ball_rate_limit' }),
      rawEvent({ timestamp: T + 120_000, seq: 1, guardId: 'hold_ball_rate_limit' }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'hold_ball must still meet threshold');
    assert.equal(result.escalated, true, 'hold_ball must still escalate');
  });

  it('a2a_block_pingpong events still escalate', async () => {
    const currentEvent = rawEvent({
      timestamp: T + 240_000,
      seq: 2,
      guardId: 'a2a_block_pingpong',
      normalizedReason: 'pingpong_streak',
    });
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
      rawEvent({
        timestamp: T + 120_000,
        seq: 1,
        guardId: 'a2a_block_pingpong',
        normalizedReason: 'pingpong_streak',
      }),
      currentEvent,
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(currentEvent, { redis, guardRejectionLog, triggerEval });

    assert.equal(result.thresholdMet, true, 'pingpong must still meet threshold');
    assert.equal(result.escalated, true, 'pingpong must still escalate');
  });
});

// ---------------------------------------------------------------------------
// 5. P2-1: byReason breakdown + sourceThreadId in snapshot/provenance
// ---------------------------------------------------------------------------

describe('snapshot byReason breakdown (sol R1 P2-1)', () => {
  // Snapshot provider uses Date.now() for the query window — test events
  // must have recent timestamps to fall within the default 7d window.
  const NOW = Date.now();

  it('snapshot includes per-reason count, category, and eligibility', async () => {
    const events = [
      rawEvent({
        timestamp: NOW - 3000,
        seq: 0,
        normalizedReason: 'dedup_active',
        guardId: 'a2a_route_decision_skip',
      }),
      rawEvent({
        timestamp: NOW - 2000,
        seq: 1,
        normalizedReason: 'dedup_active',
        guardId: 'a2a_route_decision_skip',
      }),
      rawEvent({ timestamp: NOW - 1000, seq: 2, normalizedReason: 'depth', guardId: 'a2a_route_decision_skip' }),
    ];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-byreason-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    assert.ok(result.snapshot.byReason, 'byReason must be present');
    assert.equal(result.snapshot.byReason.dedup_active.count, 2);
    assert.equal(result.snapshot.byReason.dedup_active.eligible, false);
    assert.equal(result.snapshot.byReason.dedup_active.category, 'delivery_dedup');
    assert.equal(result.snapshot.byReason.depth.count, 1);
    assert.equal(result.snapshot.byReason.depth.eligible, true);
    assert.equal(result.snapshot.byReason.depth.category, 'safety_guard');

    // Persisted snapshot matches
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.deepStrictEqual(persisted.byReason, result.snapshot.byReason, 'persisted byReason matches');
  });

  it('sourceThreadId persisted in snapshot when provided', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-srcthread-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
      sourceThreadId: 'thread_abc123',
    });

    assert.equal(result.snapshot.sourceThreadId, 'thread_abc123');
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.sourceThreadId, 'thread_abc123', 'persisted sourceThreadId');
  });

  it('sourceThreadId absent when not provided (scheduled trigger)', async () => {
    const events = [rawEvent({ timestamp: NOW - 1000, seq: 0 })];
    const { guardRejectionLog } = await createFakeEventSource(events);
    const root = mkdtempSync(join(tmpdir(), 'f257-nosrc-'));

    const result = await produceHarnessLedgerRunSnapshot({
      guardRejectionLog,
      harnessFeedbackRoot: root,
      ownerUserId: 'user_1',
    });

    assert.equal(result.snapshot.sourceThreadId, undefined);
    const persisted = JSON.parse(readFileSync(result.storagePath, 'utf8'));
    assert.equal(persisted.sourceThreadId, undefined, 'no sourceThreadId in persisted');
  });
});
