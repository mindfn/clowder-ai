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

/**
 * Fake Redis that stores data in a Map.
 * Supports atomic SET NX EX (P1-B: codebase prior art in RedisProposalStore).
 */
function createFakeRedis() {
  const store = new Map();
  return {
    get: async (key) => store.get(key) ?? null,
    /**
     * Supports: set(key, value) and set(key, value, 'EX', ttl, 'NX').
     * NX = set-if-not-exists → returns 'OK' on claim, null if key exists.
     */
    set: async (key, value, ...args) => {
      const hasNX = args.includes('NX');
      if (hasNX && store.has(key)) return null;
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
    assert.equal(until, now + 1, 'until should be event.timestamp + 1 (half-open interval includes self)');
  });

  it('concurrent threshold checks only trigger once (atomic SET NX)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(4); // above threshold
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const event = makeEvent('guard-race');
    // Simulate two concurrent checks — both see threshold met,
    // but only one wins the atomic SET NX claim.
    const [r1, r2] = await Promise.all([
      checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval }),
      checkGuardThreshold(event, { redis, guardRejectionLog: log, triggerEval }),
    ]);

    const escalated = [r1, r2].filter((r) => r.escalated);
    const deduped = [r1, r2].filter((r) => r.alreadyEscalated);
    assert.equal(escalated.length, 1, 'exactly one should win the claim');
    assert.equal(deduped.length, 1, 'exactly one should be deduped');
    assert.equal(triggerEval.mock.callCount(), 1, 'triggerEval called exactly once');
  });

  it('atomic claim sets TTL via SET EX (no separate expire call)', async () => {
    const redis = createFakeRedis();
    const log = createFakeLog(3);
    // Track the set call args to verify EX and NX are passed
    const setCalls = [];
    const originalSet = redis.set.bind(redis);
    redis.set = async (key, value, ...args) => {
      setCalls.push({ key, args });
      return originalSet(key, value, ...args);
    };
    const triggerEval = mock.fn(async () => ({ ok: true }));

    await checkGuardThreshold(makeEvent('guard-ttl'), { redis, guardRejectionLog: log, triggerEval });

    const dedupSet = setCalls.find((c) => c.key.startsWith('guard-rejection:escalated:'));
    assert.ok(dedupSet, 'should SET dedup key');
    assert.ok(dedupSet.args.includes('EX'), 'should include EX for TTL');
    assert.ok(dedupSet.args.includes('NX'), 'should include NX for atomic claim');
    assert.ok(dedupSet.args.includes(604800), 'TTL should be 7 days in seconds');
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

// ---------------------------------------------------------------------------
// Bootstrap integration test: real GuardRejectionEventLog + hook wiring
// ---------------------------------------------------------------------------

describe('F257 bootstrap integration: append → threshold escalation', async () => {
  const { GuardRejectionEventLog } = await import('../../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');

  /**
   * Combined FakeRedis that supports both ZSET ops (for GuardRejectionEventLog)
   * and key-value ops with SET NX EX (for threshold escalation dedup).
   */
  function createFullFakeRedis() {
    const store = new Map();
    const sorted = new Map();
    return {
      // Key-value (dedup)
      get: async (key) => store.get(key) ?? null,
      set: async (key, value, ...args) => {
        const hasNX = args.includes('NX');
        if (hasNX && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      expire: async () => 1,
      // Sorted set (event log)
      zadd: async (key, score, member) => {
        const s = sorted.get(key) ?? new Map();
        s.set(member, score);
        sorted.set(key, s);
        return 1;
      },
      zrangebyscore: async (key, min, max) => {
        const s = sorted.get(key);
        if (!s) return [];
        return [...s.entries()]
          .filter(([, sc]) => sc >= min && sc <= max)
          .sort((a, b) => a[1] - b[1])
          .map(([m]) => m);
      },
      zremrangebyscore: async (key, min, max) => {
        const s = sorted.get(key);
        if (!s) return 0;
        let removed = 0;
        for (const [member, score] of s) {
          if (score >= min && score <= max) {
            s.delete(member);
            removed++;
          }
        }
        return removed;
      },
      _store: store,
    };
  }

  it('real append fires hook → triggerEval called at threshold', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => ({ ok: true, domainId: 'eval:harness-ledger' }));

    // Wire hook — mirrors index.ts bootstrap pattern
    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = 1700000000000;

    // Append 2 events (below threshold) — no trigger
    await log.append(makeEvent('guard-boot', now));
    await log.append(makeEvent('guard-boot', now + 1));
    // Give fire-and-forget hooks time to settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 0, 'below threshold: no trigger');

    // Append 3rd event (reaches threshold) — triggers
    await log.append(makeEvent('guard-boot', now + 2));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1, 'at threshold: trigger fires');

    // Verify trigger input
    const input = triggerEval.mock.calls[0].arguments[0];
    assert.equal(input.domainId, 'eval:harness-ledger');
    assert.ok(input.userId.includes('guard-boot'));
  });

  it('real append: 4th event does NOT re-trigger (dedup)', async () => {
    const redis = createFullFakeRedis();
    const log = new GuardRejectionEventLog(redis);
    const triggerEval = mock.fn(async () => ({ ok: true }));

    const hook = createThresholdEscalationHook({ redis, guardRejectionLog: log, triggerEval });
    log.setPostAppendHook(hook);

    const now = 1700000000000;
    // Append 4 events — 3rd triggers, 4th deduped
    for (let i = 0; i < 4; i++) {
      await log.append(makeEvent('guard-dedup', now + i));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(triggerEval.mock.callCount(), 1, 'dedup: only one trigger despite 4 events');
  });
});
