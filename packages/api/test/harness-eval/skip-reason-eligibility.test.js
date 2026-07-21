/**
 * F257 V2 — skip-reason eligibility registry + escalation filter tests.
 *
 * Sol verdict: dedup_active false-escalation. Tests exercise:
 * 1. Registry API (isEscalationEligible, skipReasonCategory)
 * 2. Escalation integration: 3 dedup_active events don't trigger,
 *    3 eligible events do, mixed events only count eligible ones.
 * 3. hold_ball / pingpong non-regression (existing behavior preserved).
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { checkGuardThreshold } from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';
import {
  isEscalationEligible,
  SKIP_REASON_ELIGIBILITY,
  skipReasonCategory,
} from '../../dist/infrastructure/harness-eval/skip-reason-eligibility.js';
import { createFakeEventSource, rawEvent, T, triggerSuccess } from './_guard-test-helpers.js';

// ---------------------------------------------------------------------------
// 1. Registry unit tests
// ---------------------------------------------------------------------------

describe('skip-reason eligibility registry', () => {
  it('dedup_active is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('dedup_active'), false);
  });

  it('aborted is NOT eligible for escalation', () => {
    assert.equal(isEscalationEligible('aborted'), false);
  });

  it('depth IS eligible for escalation', () => {
    assert.equal(isEscalationEligible('depth'), true);
  });

  it('queue_pending IS eligible for escalation', () => {
    assert.equal(isEscalationEligible('queue_pending'), true);
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

  it('prototype keys are not eligible entries', () => {
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'toString'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, 'constructor'), false);
    assert.equal(Object.hasOwn(SKIP_REASON_ELIGIBILITY, '__proto__'), false);
  });
});

describe('skipReasonCategory', () => {
  it('dedup_active → delivery_dedup', () => {
    assert.equal(skipReasonCategory('dedup_active'), 'delivery_dedup');
  });

  it('depth → capacity_limit', () => {
    assert.equal(skipReasonCategory('depth'), 'capacity_limit');
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
// 2. Escalation integration: dedup_active events don't trigger
// ---------------------------------------------------------------------------

describe('escalation eligibility filter — dedup_active (sol verdict)', () => {
  it('3 dedup_active events with >60s gaps do NOT trigger escalation', async () => {
    // 3 distinct episodes (gap > 60s each), but all are dedup_active —
    // should be filtered out and NOT meet the threshold.
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
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(
      rawEvent({
        timestamp: T + 360_000,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      { redis, guardRejectionLog, triggerEval },
    );

    assert.equal(result.thresholdMet, false, 'dedup_active must NOT meet threshold');
    assert.equal(result.escalated, false, 'must NOT escalate');
    assert.equal(result.episodeCount, 0, 'eligible episode count must be 0');
    assert.equal(triggerEval.mock.callCount(), 0, 'triggerEval must NOT be called');
  });

  it('3 eligible (depth) events with >60s gaps DO trigger escalation', async () => {
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
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(
      rawEvent({
        timestamp: T + 360_000,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'depth',
      }),
      { redis, guardRejectionLog, triggerEval },
    );

    assert.equal(result.thresholdMet, true, 'eligible events must meet threshold');
    assert.equal(result.escalated, true, 'must escalate');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval must be called once');
  });

  it('mixed: 5 dedup_active + 2 eligible → does NOT escalate (only 2 eligible episodes)', async () => {
    const events = [
      // 5 dedup_active — all should be filtered
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
      // 2 eligible (depth) — not enough to meet threshold=3
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      rawEvent({ timestamp: T + 720_000, seq: 6, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(
      rawEvent({ timestamp: T + 840_000, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      { redis, guardRejectionLog, triggerEval },
    );

    assert.equal(result.episodeCount, 2, 'only 2 eligible episodes');
    assert.equal(result.thresholdMet, false, 'below threshold');
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0);
  });

  it('mixed: 3 dedup_active + 3 eligible → DOES escalate (3 eligible episodes)', async () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_route_decision_skip', normalizedReason: 'dedup_active' }),
      rawEvent({ timestamp: T + 120_000, seq: 1, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      rawEvent({
        timestamp: T + 240_000,
        seq: 2,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 360_000, seq: 3, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      rawEvent({
        timestamp: T + 480_000,
        seq: 4,
        guardId: 'a2a_route_decision_skip',
        normalizedReason: 'dedup_active',
      }),
      rawEvent({ timestamp: T + 600_000, seq: 5, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(
      rawEvent({ timestamp: T + 720_000, guardId: 'a2a_route_decision_skip', normalizedReason: 'depth' }),
      { redis, guardRejectionLog, triggerEval },
    );

    assert.equal(result.thresholdMet, true, '3 eligible episodes meet threshold');
    assert.equal(result.escalated, true);
    assert.equal(triggerEval.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Non-regression: hold_ball and pingpong still escalate
// ---------------------------------------------------------------------------

describe('escalation non-regression — hold_ball and pingpong', () => {
  it('hold_ball_rate_limit events still escalate (no normalizedReason filter)', async () => {
    // hold_ball events use a different guardId — eligibility filter only
    // applies to normalizedReason, and hold_ball events don't have
    // reason='dedup_active'. They should still escalate normally.
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'hold_ball_rate_limit' }),
      rawEvent({ timestamp: T + 120_000, seq: 1, guardId: 'hold_ball_rate_limit' }),
      rawEvent({ timestamp: T + 240_000, seq: 2, guardId: 'hold_ball_rate_limit' }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(rawEvent({ timestamp: T + 360_000, guardId: 'hold_ball_rate_limit' }), {
      redis,
      guardRejectionLog,
      triggerEval,
    });

    assert.equal(result.thresholdMet, true, 'hold_ball must still meet threshold');
    assert.equal(result.escalated, true, 'hold_ball must still escalate');
  });

  it('a2a_block_pingpong events still escalate', async () => {
    const events = [
      rawEvent({ timestamp: T, seq: 0, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
      rawEvent({ timestamp: T + 120_000, seq: 1, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
      rawEvent({ timestamp: T + 240_000, seq: 2, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
    ];
    const { redis, guardRejectionLog } = await createFakeEventSource(events);
    const triggerEval = mock.fn(async () => triggerSuccess());

    const result = await checkGuardThreshold(
      rawEvent({ timestamp: T + 360_000, guardId: 'a2a_block_pingpong', normalizedReason: 'pingpong_streak' }),
      { redis, guardRejectionLog, triggerEval },
    );

    assert.equal(result.thresholdMet, true, 'pingpong must still meet threshold');
    assert.equal(result.escalated, true, 'pingpong must still escalate');
  });
});
