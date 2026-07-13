import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  checkGuardThreshold,
  createThresholdEscalationHook,
  ESCALATION_THRESHOLD,
  ESCALATION_WINDOW_DAYS,
} from '../../dist/infrastructure/harness-eval/guard-threshold-escalation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake Redis that stores data in a Map (good enough for dedup key tests). */
function createFakeRedis() {
  const store = new Map();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
    expire: async () => 1,
    _store: store,
  };
}

/** Fake GuardRejectionEventLog that returns a fixed count for countByGuard. */
function createFakeLog(countByGuardResult) {
  return {
    countByGuard: mock.fn(async () => countByGuardResult),
    queryWindow: async () => [],
    queryWindowStrict: async () => [],
    append: async () => {},
  };
}

function makeEvent(guardId = 'hold_ball_rate_limit', timestamp = Date.now()) {
  return {
    eventId: `evt-${timestamp}`,
    kind: 'http_rate_limit',
    threadId: 'thread_1',
    catId: 'cat_1',
    guardId,
    timestamp,
    correlationConfidence: 'window',
    currentCount: 5,
    maxAllowed: 5,
    windowMs: 3600000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F257 sub-item 2: guard threshold escalation', () => {
  it('exports correct threshold constants', () => {
    assert.equal(ESCALATION_THRESHOLD, 3, 'threshold should be 3 events');
    assert.equal(ESCALATION_WINDOW_DAYS, 7, 'window should be 7 days');
  });

  it('does NOT escalate when count < threshold', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(2); // below threshold of 3
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const result = await checkGuardThreshold(makeEvent(), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, false);
    assert.equal(result.escalated, false);
    assert.equal(triggerEval.mock.callCount(), 0, 'should NOT trigger eval');
  });

  it('escalates when count >= threshold (first time)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3); // exactly at threshold
    const triggerEval = mock.fn(async () => ({ ok: true, domainId: 'eval:harness-ledger' }));

    const result = await checkGuardThreshold(makeEvent('guard-x'), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(result.checked, true);
    assert.equal(result.thresholdMet, true);
    assert.equal(result.alreadyEscalated, false);
    assert.equal(result.escalated, true);
    assert.equal(result.count, 3);

    // triggerEval called with eval:harness-ledger
    assert.equal(triggerEval.mock.callCount(), 1);
    const triggerInput = triggerEval.mock.calls[0].arguments[0];
    assert.equal(triggerInput.domainId, 'eval:harness-ledger');
    assert.ok(triggerInput.userId.includes('guard-x'), 'userId should contain guardId');
  });

  it('does NOT re-escalate same guard (dedup key exists)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(5); // above threshold
    const triggerEval = mock.fn(async () => ({ ok: true }));

    // First call: escalates
    const event = makeEvent('guard-y');
    const first = await checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval });
    assert.equal(first.escalated, true);

    // Second call: dedup key exists → should NOT re-escalate
    const second = await checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval });
    assert.equal(second.thresholdMet, true);
    assert.equal(second.alreadyEscalated, true);
    assert.equal(second.escalated, false);

    // triggerEval called only ONCE (first time)
    assert.equal(triggerEval.mock.callCount(), 1, 'should only trigger once per dedup window');
  });

  it('dedup key is set in Redis with correct prefix', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    const triggerEval = mock.fn(async () => ({ ok: true }));

    await checkGuardThreshold(makeEvent('guard-z'), { redis, guardRejectionLog: log, triggerEval });

    // Check Redis store for dedup key
    const dedupKey = 'guard-rejection:escalated:guard-z';
    const stored = redis._store.get(dedupKey);
    assert.ok(stored, 'dedup key should exist in Redis');
    const parsed = JSON.parse(stored);
    assert.equal(parsed.count, 3);
    assert.ok(parsed.escalatedAt, 'should record escalation timestamp');
    assert.ok(parsed.triggeredBy, 'should record triggering event ID');
  });

  it('different guards escalate independently', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(4);
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const r1 = await checkGuardThreshold(makeEvent('guard-a'), { redis, guardRejectionLog: log, triggerEval });
    const r2 = await checkGuardThreshold(makeEvent('guard-b'), { redis, guardRejectionLog: log, triggerEval });

    assert.equal(r1.escalated, true, 'guard-a should escalate');
    assert.equal(r2.escalated, true, 'guard-b should escalate independently');
    assert.equal(triggerEval.mock.callCount(), 2, 'both guards should trigger eval');
  });

  it('countByGuard receives correct window parameters', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(1); // below threshold
    const triggerEval = mock.fn(async () => ({}));
    const now = 1700000000000;

    await checkGuardThreshold(makeEvent('guard-q', now), { redis, guardRejectionLog: log, triggerEval });

    // countByGuard should be called with (guardId, since, until)
    assert.equal(log.countByGuard.mock.callCount(), 1);
    const [guardId, since, until] = log.countByGuard.mock.calls[0].arguments;
    assert.equal(guardId, 'guard-q');
    const expectedWindowMs = ESCALATION_WINDOW_DAYS * 24 * 3600 * 1000;
    assert.equal(since, now - expectedWindowMs, 'since should be event.timestamp - 7 days');
    assert.equal(until, now, 'until should be event.timestamp');
  });
});

describe('createThresholdEscalationHook', () => {
  it('returns a synchronous function (fire-and-forget pattern)', () => {
    const hook = createThresholdEscalationHook({
      redis: createFakeRedis(),
      guardRejectionLog: createFakeLog(0),
      triggerEval: async () => ({}),
    });

    assert.equal(typeof hook, 'function');
    // Calling it should not throw (fire-and-forget)
    assert.doesNotThrow(() => hook(makeEvent()));
  });
});
