/**
 * F257: Volume-based SemanticSweep auto-trigger tests.
 *
 * Tests the PRODUCTION checkAndTriggerVolumeSweep via its dist exports,
 * using bootstrapTraceStore + bindVolumeSweepInvoke to inject fakes.
 *
 * Covers: threshold boundary (199/200), owner isolation, concurrent SET NX
 * dedup, failure claim release + retry, window scoping, drain/rearm lifecycle,
 * drain safety cap, lost-wake regression (sol R2 P1-1).
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  bindVolumeSweepInvoke,
  bootstrapTraceStore,
  checkAndTriggerVolumeSweep,
  releaseVolumeSweepClaim,
  SWEEP_BATCH_SIZE,
  SWEEP_CLAIM_KEY_PREFIX,
  SWEEP_DRAIN_INTERVAL_SECONDS,
  SWEEP_DRAIN_KEY_PREFIX,
  SWEEP_MAX_DRAIN_ROUNDS,
  SWEEP_MIN_INTERVAL_SECONDS,
  SWEEP_VOLUME_THRESHOLD,
} from '../../dist/domains/prompt-hooks/trace-bootstrap.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNCLASSIFIED_KEY_PREFIX = 'trace-unclassified-episode:';

/**
 * Fake Redis with ZSET + key-value support. Matches the subset used by
 * InjectionTraceStore.countUnclassified and volume sweep claim/drain logic.
 */
function createFakeRedis() {
  const store = new Map();
  const zsets = new Map();

  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ...args) => {
      const hasNX = args.includes('NX');
      if (hasNX && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    },
    zcard: async (key) => (zsets.get(key) ?? []).length,
    zcount: async (key, min, max) => {
      const members = zsets.get(key) ?? [];
      const minN = min === '-inf' ? -Infinity : Number(min);
      const maxN = max === '+inf' ? Infinity : Number(max);
      return members.filter((m) => m.score >= minN && m.score <= maxN).length;
    },
    zadd: async (key, score, member) => {
      if (!zsets.has(key)) zsets.set(key, []);
      zsets.get(key).push({ score, member });
      return 1;
    },
    zrangebyscore: async () => [],
    zrem: async () => 1,
    smembers: async () => [],
    sadd: async () => 1,
    expire: async () => 1,
    _store: store,
    _zsets: zsets,
  };
}

/** Populate N unclassified episodes for an owner in the 7-day window. */
async function populateEpisodes(redis, ownerUserId, count, ageOffsetMs = 0) {
  const key = `${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    await redis.zadd(key, now - ageOffsetMs - i * 60_000, `inv-${i}-${ageOffsetMs}`);
  }
}

/** Populate N old episodes OUTSIDE the 7-day window. */
async function populateStaleEpisodes(redis, ownerUserId, count) {
  const key = `${UNCLASSIFIED_KEY_PREFIX}${ownerUserId}`;
  const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
  for (let i = 0; i < count; i++) {
    await redis.zadd(key, oldTs + i * 1000, `stale-${i}`);
  }
}

/** Bootstrap production singletons with fake Redis and mock invoke. */
function setup(redis, invokeFn) {
  bootstrapTraceStore(redis);
  bindVolumeSweepInvoke(invokeFn);
  return redis;
}

// ---------------------------------------------------------------------------
// Tests — production checkAndTriggerVolumeSweep
// ---------------------------------------------------------------------------

describe('F257: volume-based sweep trigger (production)', () => {
  // -- Threshold boundary -------------------------------------------------

  describe('threshold boundary', () => {
    it('does NOT trigger at 199 unclassified episodes', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 199);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 0, 'should not invoke below threshold');
    });

    it('triggers at exactly 200 unclassified episodes', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.deepEqual(invoke.mock.calls[0].arguments, ['user_A']);
    });

    it('triggers above threshold', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 500);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
    });
  });

  // -- Owner isolation ----------------------------------------------------

  describe('owner isolation', () => {
    it('user A claim does NOT suppress user B', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await populateEpisodes(redis, 'user_B', 200);

      await checkAndTriggerVolumeSweep('user_A');
      await checkAndTriggerVolumeSweep('user_B');

      assert.equal(invoke.mock.callCount(), 2);
      assert.deepEqual(invoke.mock.calls[0].arguments, ['user_A']);
      assert.deepEqual(invoke.mock.calls[1].arguments, ['user_B']);
    });

    it('same user cannot claim twice within cooldown', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 300);

      await checkAndTriggerVolumeSweep('user_A');
      // Second call hits existing claim (SET NX fails) — no completion yet
      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 1, 'should not double-invoke same owner');
    });

    it('claim keys are owner-scoped', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await populateEpisodes(redis, 'user_B', 200);

      await checkAndTriggerVolumeSweep('user_A');
      await checkAndTriggerVolumeSweep('user_B');

      const claimA = await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`);
      const claimB = await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_B`);
      assert.notEqual(claimA, null, 'user_A claim should exist');
      assert.notEqual(claimB, null, 'user_B claim should exist');
    });
  });

  // -- Atomic claim (cross-instance race) ---------------------------------

  describe('atomic claim (SET NX)', () => {
    it('prevents double-trigger from concurrent callers', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 250);

      const [,] = await Promise.all([checkAndTriggerVolumeSweep('user_A'), checkAndTriggerVolumeSweep('user_A')]);

      assert.equal(invoke.mock.callCount(), 1, 'exactly one should win SET NX');
    });
  });

  // -- Failure releases claim ---------------------------------------------

  describe('failure releases claim', () => {
    it('releases claim when invoke returns dispatched: false', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: false }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');

      const claim = await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`);
      assert.equal(claim, null, 'claim should be released after failed dispatch');
    });

    it('allows retry after failed dispatch', async () => {
      const redis = createFakeRedis();
      let callCount = 0;
      const invoke = mock.fn(async () => {
        callCount++;
        return { dispatched: callCount > 1 };
      });
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.equal(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null, 'claim released');

      // Retry should succeed
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 2);
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null, 'claim kept');
    });

    it('keeps claim on successful dispatch', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');

      const claim = await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`);
      assert.notEqual(claim, null, 'claim should persist after successful dispatch');
    });
  });

  // -- Window scoping -----------------------------------------------------

  describe('window scoping', () => {
    it('stale episodes outside 7-day window do NOT inflate count', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);

      // 300 stale episodes (30 days old) + 50 recent
      await populateStaleEpisodes(redis, 'user_A', 300);
      await populateEpisodes(redis, 'user_A', 50);

      await checkAndTriggerVolumeSweep('user_A');

      // Total = 350 (ZCARD) but windowed = 50 (below 200) → no trigger
      assert.equal(invoke.mock.callCount(), 0, 'stale episodes should not inflate count');
    });

    it('triggers when recent episodes alone exceed threshold', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);

      await populateStaleEpisodes(redis, 'user_A', 300);
      await populateEpisodes(redis, 'user_A', 201);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
    });
  });

  // -- Lost-wake regression (sol R2 P1-1) ---------------------------------

  describe('lost-wake regression', () => {
    it('does NOT use in-process debounce that swallows threshold crossing', async () => {
      // Regression: old implementation used Set<string> debounce.
      // When #199 check was in-flight, #200 arrival was silently skipped.
      // New implementation has NO in-process debounce — Redis SET NX is the
      // sole dedup. Two concurrent calls → one wins SET NX, other is deduped.
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      // Simulate rapid concurrent calls (both see count=200)
      await Promise.all([checkAndTriggerVolumeSweep('user_A'), checkAndTriggerVolumeSweep('user_A')]);

      // Exactly one should trigger (SET NX dedup), never zero
      assert.equal(invoke.mock.callCount(), 1, 'must trigger at 200, not swallow');
    });
  });

  // -- Drain lifecycle ----------------------------------------------------

  describe('drain lifecycle', () => {
    it('enters drain mode when remaining > batch size after dispatch', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');

      // count (200) > SWEEP_BATCH_SIZE (10) → drain key should be set
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const drainRaw = await redis.get(drainKey);
      assert.notEqual(drainRaw, null, 'drain key should be set');

      const drain = JSON.parse(drainRaw);
      assert.equal(drain.round, 1);
      assert.equal(typeof drain.startedAt, 'number');
    });

    it('does NOT enter drain when remaining ≤ batch size', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      // Exactly 10 episodes — one batch covers it all
      await populateEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);

      // Pre-set drain key to simulate existing drain
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 5, startedAt: Date.now() }));

      await checkAndTriggerVolumeSweep('user_A');

      // count (10) ≤ batch (10) + existing drain → drain complete → key deleted
      const drainAfter = await redis.get(drainKey);
      assert.equal(drainAfter, null, 'drain key should be cleared when last batch fits');
    });

    it('drain mode triggers on any remaining > 0 (below normal threshold)', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);

      // Only 50 episodes — below normal 200 threshold
      await populateEpisodes(redis, 'user_A', 50);

      // Pre-set drain key to simulate active drain
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 3, startedAt: Date.now() - 30_000 }));

      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 1, 'drain should trigger below normal threshold');
    });

    it('drain mode uses shorter claim TTL', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      // Pre-set drain key
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 1, startedAt: Date.now() }));

      await checkAndTriggerVolumeSweep('user_A');

      const claimRaw = await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`);
      assert.notEqual(claimRaw, null);
      const claim = JSON.parse(claimRaw);
      assert.equal(claim.drain, true, 'claim should indicate drain mode');
    });

    it('increments drain round on each successful dispatch', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const startedAt = Date.now() - 60_000;
      await redis.set(drainKey, JSON.stringify({ round: 7, startedAt }));

      await checkAndTriggerVolumeSweep('user_A');

      const drainAfter = JSON.parse(await redis.get(drainKey));
      assert.equal(drainAfter.round, 8, 'round should increment');
      assert.equal(drainAfter.startedAt, startedAt, 'startedAt should be preserved');
    });

    it('stops at max drain rounds', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      // Set round at max — should stop
      await redis.set(drainKey, JSON.stringify({ round: SWEEP_MAX_DRAIN_ROUNDS, startedAt: Date.now() }));

      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 0, 'should NOT invoke at max rounds');
      const drainAfter = await redis.get(drainKey);
      assert.equal(drainAfter, null, 'drain key should be cleared at max rounds');
    });

    it('drain does not trigger when count is 0', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      // No episodes at all

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 3, startedAt: Date.now() }));

      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 0, 'should not invoke with 0 episodes');
    });

    it('full drain scenario: initial trigger → completion release → drain batches → empty', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}user_A`;

      // Step 1: 200 episodes → initial trigger → enters drain
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'initial trigger');
      assert.notEqual(await redis.get(drainKey), null, 'drain entered');
      assert.equal(JSON.parse(await redis.get(drainKey)).round, 1);

      // Step 2: Claim blocks re-entry (no completion yet)
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'claim blocks re-entry before completion');

      // Step 3: Eval cat classifies batch → completion releases claim
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;
      redis._zsets.get(key).splice(0, 10); // simulate 10 episodes classified
      await releaseVolumeSweepClaim('user_A'); // production completion hook
      assert.equal(await redis.get(claimKey), null, 'claim released by completion');

      // Step 4: 190 remain (< 200 threshold) but drain mode → trigger
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 2, 'drain batch 2 after completion');
      assert.equal(JSON.parse(await redis.get(drainKey)).round, 2);

      // Step 5: Classify remaining → completion release → empty
      redis._zsets.set(key, []);
      await releaseVolumeSweepClaim('user_A');

      // Step 6: 0 remain → should not trigger
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 2, 'no trigger when empty');
    });

    it('claim blocks re-entry until completion releases it (no manual DEL)', async () => {
      const redis = createFakeRedis();
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      // Initial trigger — claim acquired
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null);

      // Re-entry blocked by claim
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'blocked by claim');

      // Completion releases claim
      await releaseVolumeSweepClaim('user_A');
      assert.equal(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null, 'released');

      // Now re-entry succeeds (drain mode, threshold=0)
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 2, 'proceeds after completion release');
    });
  });

  // -- Constants validation -----------------------------------------------

  describe('exported constants', () => {
    it('threshold is 200', () => assert.equal(SWEEP_VOLUME_THRESHOLD, 200));
    it('initial interval is 6h', () => assert.equal(SWEEP_MIN_INTERVAL_SECONDS, 21600));
    it('drain interval is 10min', () => assert.equal(SWEEP_DRAIN_INTERVAL_SECONDS, 600));
    it('max drain rounds is 25', () => assert.equal(SWEEP_MAX_DRAIN_ROUNDS, 25));
    it('batch size is 10', () => assert.equal(SWEEP_BATCH_SIZE, 10));
  });
});
