/**
 * F257: Volume-based SemanticSweep auto-trigger tests.
 *
 * Tests the PRODUCTION checkAndTriggerVolumeSweep via its dist exports,
 * using bootstrapTraceStore + bindVolumeSweepInvoke to inject fakes.
 *
 * Covers: threshold boundary (199/200), owner isolation, concurrent SET NX
 * dedup, failure claim release + retry, window scoping, drain/rearm lifecycle,
 * drain safety cap, lost-wake regression (sol R2 P1-1), completion-driven
 * drain with jobId fencing (sol R4 P1-1/P1-2), TTL tracking (sol R4 P2-2).
 *
 * [宪宪/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  advanceVolumeSweepDrain,
  bindVolumeSweepInvoke,
  bootstrapTraceStore,
  checkAndTriggerVolumeSweep,
  SWEEP_BATCH_SIZE,
  SWEEP_CLAIM_KEY_PREFIX,
  SWEEP_DRAIN_INTERVAL_SECONDS,
  SWEEP_DRAIN_KEY_PREFIX,
  SWEEP_DRAIN_TTL_SECONDS,
  SWEEP_MAX_DRAIN_ROUNDS,
  SWEEP_MIN_INTERVAL_SECONDS,
  SWEEP_VOLUME_THRESHOLD,
} from '../../dist/domains/prompt-hooks/trace-bootstrap.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNCLASSIFIED_KEY_PREFIX = 'trace-unclassified-episode:';

/**
 * Fake Redis with ZSET + key-value + TTL tracking (sol R4 P2-2).
 * TTL values are recorded in _ttls for assertions but keys do NOT
 * auto-expire (tests run synchronously).
 */
function createFakeRedis() {
  const store = new Map();
  const zsets = new Map();
  const ttls = new Map();

  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value, ...args) => {
      const hasNX = args.includes('NX');
      if (hasNX && store.has(key)) return null;
      store.set(key, value);
      const exIdx = args.indexOf('EX');
      if (exIdx >= 0) ttls.set(key, args[exIdx + 1]);
      return 'OK';
    },
    del: async (key) => {
      const existed = store.has(key);
      store.delete(key);
      ttls.delete(key);
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
    /**
     * Lua script emulation for ADVANCE_DRAIN_LUA (sol R5 P1-1).
     * JS equivalent of the atomic fenced drain advance script.
     * KEYS = [drainKey, claimKey], ARGV = [completedJobId].
     */
    eval: async (_script, numKeys, ...args) => {
      const keys = args.slice(0, numKeys);
      const argv = args.slice(numKeys);
      const drainRaw = store.get(keys[0]) ?? null;
      if (!drainRaw) return 0;
      const drain = JSON.parse(drainRaw);
      if (typeof drain.jobId !== 'string' || drain.jobId !== argv[0]) return -1;
      drain.jobId = '__consumed__';
      store.set(keys[0], JSON.stringify(drain));
      // Preserve TTL
      store.delete(keys[1]);
      ttls.delete(keys[1]);
      return 1;
    },
    _store: store,
    _zsets: zsets,
    _ttls: ttls,
  };
}

/** Populate N unclassified episodes in the 7-day window. */
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
  const oldTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
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

/** Create an invoke mock that returns incrementing jobIds. */
function createJobInvoke() {
  let seq = 0;
  return mock.fn(async () => ({ dispatched: true, jobId: `job-${++seq}` }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('F257: volume-based sweep trigger (production)', () => {
  // -- Threshold boundary -------------------------------------------------

  describe('threshold boundary', () => {
    it('does NOT trigger at 199 unclassified episodes', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 199);
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 0, 'should not invoke below threshold');
    });

    it('triggers at exactly 200 unclassified episodes', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.deepEqual(invoke.mock.calls[0].arguments, ['user_A']);
    });

    it('triggers above threshold', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
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
      const invoke = createJobInvoke();
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
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 300);
      await checkAndTriggerVolumeSweep('user_A');
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'should not double-invoke same owner');
    });

    it('claim keys are owner-scoped', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await populateEpisodes(redis, 'user_B', 200);
      await checkAndTriggerVolumeSweep('user_A');
      await checkAndTriggerVolumeSweep('user_B');
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null);
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_B`), null);
    });
  });

  // -- Atomic claim (cross-instance race) ---------------------------------

  describe('atomic claim (SET NX)', () => {
    it('prevents double-trigger from concurrent callers', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
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
      assert.equal(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null);
    });

    it('allows retry after failed dispatch', async () => {
      const redis = createFakeRedis();
      let callCount = 0;
      const invoke = mock.fn(async () => {
        callCount++;
        return callCount > 1 ? { dispatched: true, jobId: `job-${callCount}` } : { dispatched: false };
      });
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.equal(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null, 'claim released');

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 2);
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null, 'claim kept');
    });

    it('keeps claim on successful dispatch', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null);
    });
  });

  // -- Window scoping -----------------------------------------------------

  describe('window scoping', () => {
    it('stale episodes outside 7-day window do NOT inflate count', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateStaleEpisodes(redis, 'user_A', 300);
      await populateEpisodes(redis, 'user_A', 50);
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 0, 'stale episodes should not inflate count');
    });

    it('triggers when recent episodes alone exceed threshold', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
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
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await Promise.all([checkAndTriggerVolumeSweep('user_A'), checkAndTriggerVolumeSweep('user_A')]);
      assert.equal(invoke.mock.callCount(), 1, 'must trigger at 200, not swallow');
    });
  });

  // -- Drain lifecycle ----------------------------------------------------

  describe('drain lifecycle', () => {
    it('enters drain mode with jobId when remaining > batch size', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const drain = JSON.parse(await redis.get(drainKey));
      assert.equal(drain.round, 1);
      assert.equal(typeof drain.startedAt, 'number');
      assert.equal(drain.jobId, 'job-1', 'jobId stored for fencing');
    });

    it('retains drain key for final batch until completion (sol R5 P1-2)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 5, startedAt: Date.now(), jobId: 'prev' }));
      await checkAndTriggerVolumeSweep('user_A');

      // Drain key retained — NOT deleted at dispatch (sol R5 P1-2)
      const drain = JSON.parse(await redis.get(drainKey));
      assert.equal(drain.round, 6, 'round incremented');
      assert.equal(drain.jobId, 'job-1', 'new jobId for completion fence');
    });

    it('drain mode triggers on any remaining > 0 (below normal threshold)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 3, startedAt: Date.now() - 30_000, jobId: 'prev' }));
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'drain triggers below normal threshold');
    });

    it('drain mode claim indicates drain: true', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 1, startedAt: Date.now(), jobId: 'prev' }));
      await checkAndTriggerVolumeSweep('user_A');

      const claim = JSON.parse(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`));
      assert.equal(claim.drain, true, 'claim should indicate drain mode');
    });

    it('increments drain round and stores new jobId', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const startedAt = Date.now() - 60_000;
      await redis.set(drainKey, JSON.stringify({ round: 7, startedAt, jobId: 'prev' }));
      await checkAndTriggerVolumeSweep('user_A');

      const drain = JSON.parse(await redis.get(drainKey));
      assert.equal(drain.round, 8, 'round should increment');
      assert.equal(drain.startedAt, startedAt, 'startedAt preserved');
      assert.equal(drain.jobId, 'job-1', 'new jobId stored');
    });

    it('stops at max drain rounds', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 50);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(
        drainKey,
        JSON.stringify({ round: SWEEP_MAX_DRAIN_ROUNDS, startedAt: Date.now(), jobId: 'prev' }),
      );
      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 0, 'should NOT invoke at max rounds');
      assert.equal(await redis.get(drainKey), null, 'drain key cleared at max rounds');
    });

    it('zero count exits drain and cleans up drain key (sol R4 P2-1)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      // No episodes at all

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 3, startedAt: Date.now(), jobId: 'prev' }));
      await checkAndTriggerVolumeSweep('user_A');

      assert.equal(invoke.mock.callCount(), 0, 'no invoke with 0 episodes');
      assert.equal(await redis.get(drainKey), null, 'drain key cleaned on zero-count exit');
    });

    it('full drain: trigger -> completion advance -> drain -> empty (sol R4)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);

      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;

      // Step 1: 200 episodes -> initial trigger -> enters drain
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'initial trigger');
      const drain1 = JSON.parse(await redis.get(drainKey));
      assert.equal(drain1.round, 1);
      assert.equal(drain1.jobId, 'job-1');

      // Step 2: Claim blocks re-entry before completion
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'claim blocks re-entry');

      // Step 3: Classify 10 -> completion advances drain -> auto-dispatches next
      redis._zsets.get(key).splice(0, 10);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2, 'drain batch 2 auto-dispatched');
      const drain2 = JSON.parse(await redis.get(drainKey));
      assert.equal(drain2.round, 2);
      assert.equal(drain2.jobId, 'job-2');

      // Step 4: Classify all remaining -> drain exits (count=0)
      redis._zsets.set(key, []);
      await advanceVolumeSweepDrain('user_A', 'job-2');
      assert.equal(invoke.mock.callCount(), 2, 'no trigger when empty');
      assert.equal(await redis.get(drainKey), null, 'drain key cleaned on exit');
    });

    it('claim blocks re-entry until completion advances drain (no manual DEL)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);
      assert.notEqual(await redis.get(`${SWEEP_CLAIM_KEY_PREFIX}user_A`), null);

      // Re-entry blocked
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'blocked by claim');

      // Completion advances drain -> releases claim + dispatches next
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2, 'proceeds after completion advance');
    });
  });

  // -- JobId fencing (sol R4 P1-2) ----------------------------------------

  describe('jobId fencing', () => {
    it('unrelated jobId does NOT release claim', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);

      const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}user_A`;
      assert.notEqual(await redis.get(claimKey), null, 'claim exists');

      // Wrong jobId — manual/guard sweep or idempotent replay
      await advanceVolumeSweepDrain('user_A', 'unrelated-manual-sweep-job');

      assert.notEqual(await redis.get(claimKey), null, 'claim NOT released');
      assert.equal(invoke.mock.callCount(), 1, 'no additional dispatch');
    });

    it('matching jobId releases claim and dispatches next', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      const drain = JSON.parse(await redis.get(`${SWEEP_DRAIN_KEY_PREFIX}user_A`));
      assert.equal(drain.jobId, 'job-1');

      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2, 'next batch dispatched');
    });

    it('no drain key -> advance is no-op (non-volume sweep)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await advanceVolumeSweepDrain('user_A', 'some-manual-job');
      assert.equal(invoke.mock.callCount(), 0, 'no dispatch when no drain active');
    });

    it('duplicate completion: only first advances (atomic Lua, sol R5 P1-1)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);

      // Simulate 10 classified
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;
      redis._zsets.get(key).splice(0, 10);

      // Two completions for same job-1 — Lua makes this atomic
      await Promise.all([advanceVolumeSweepDrain('user_A', 'job-1'), advanceVolumeSweepDrain('user_A', 'job-1')]);

      // Exactly one should advance: Lua invalidates jobId on first pass,
      // second sees '__consumed__' and returns -1. SET NX prevents double dispatch.
      assert.equal(invoke.mock.callCount(), 2, 'exactly one additional dispatch');
    });

    it('missing jobId in drain key fails closed (sol R5 P1-3)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);

      // Manually set drain key WITHOUT jobId (old format / edge case)
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 1, startedAt: Date.now() }));
      // Set a claim key
      const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}user_A`;
      await redis.set(claimKey, JSON.stringify({ drain: true }));

      // Any completion should fail closed — cannot fence without jobId
      await advanceVolumeSweepDrain('user_A', 'any-job-id');

      assert.notEqual(await redis.get(claimKey), null, 'claim NOT released');
      assert.equal(invoke.mock.callCount(), 0, 'no dispatch from missing-jobId drain');
    });

    it('dispatch without jobId treated as failed (sol R5 P1-3)', async () => {
      const redis = createFakeRedis();
      // Return dispatched: true but NO jobId
      const invoke = mock.fn(async () => ({ dispatched: true }));
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);

      // Claim should be released (treated as failed dispatch)
      const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}user_A`;
      assert.equal(await redis.get(claimKey), null, 'claim released — no jobId');
      // No drain key entered
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      assert.equal(await redis.get(drainKey), null, 'no drain without jobId');
    });
  });

  // -- TTL tracking (sol R4 P2-2) -----------------------------------------

  describe('TTL tracking', () => {
    it('initial trigger sets drain-mode TTLs on claim and drain key', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      await checkAndTriggerVolumeSweep('user_A');

      const claimKey = `${SWEEP_CLAIM_KEY_PREFIX}user_A`;
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      // count (200) > batch (10) -> enters drain -> claim TTL shortened
      assert.equal(redis._ttls.get(claimKey), SWEEP_DRAIN_INTERVAL_SECONDS, 'claim TTL = 10min');
      assert.equal(redis._ttls.get(drainKey), SWEEP_DRAIN_TTL_SECONDS, 'drain TTL = 20min');
    });

    it('TTL cleared on del', async () => {
      const redis = createFakeRedis();
      await redis.set('test-key', 'val', 'EX', 300);
      assert.equal(redis._ttls.get('test-key'), 300);
      await redis.del('test-key');
      assert.equal(redis._ttls.has('test-key'), false, 'TTL cleared after del');
    });
  });

  // -- Completion-driven dispatch (sol R4 P1-1) ---------------------------

  describe('completion-driven dispatch', () => {
    it('advanceVolumeSweepDrain dispatches next batch without manual checker call', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);

      // Initial trigger -> drain with jobId 'job-1'
      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'initial dispatch');

      // Simulate batch classification
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;
      redis._zsets.get(key).splice(0, 10);

      // Completion hook -> releases claim AND dispatches next batch
      await advanceVolumeSweepDrain('user_A', 'job-1');

      assert.equal(invoke.mock.callCount(), 2, 'second batch auto-dispatched');
      const drain = JSON.parse(await redis.get(`${SWEEP_DRAIN_KEY_PREFIX}user_A`));
      assert.equal(drain.round, 2, 'drain round incremented');
      assert.equal(drain.jobId, 'job-2', 'new jobId for next fence');
    });

    it('final batch retained: completion at zero count cleans up (sol R5 P1-2)', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);

      // Start with exactly SWEEP_BATCH_SIZE episodes in drain
      await populateEpisodes(redis, 'user_A', SWEEP_BATCH_SIZE);
      const drainKey = `${SWEEP_DRAIN_KEY_PREFIX}user_A`;
      await redis.set(drainKey, JSON.stringify({ round: 5, startedAt: Date.now(), jobId: 'prev' }));

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1, 'final batch dispatched');

      // Drain key retained (NOT deleted at dispatch time)
      const drain = JSON.parse(await redis.get(drainKey));
      assert.equal(drain.round, 6);
      assert.equal(drain.jobId, 'job-1');

      // Classify all -> completion at zero count -> drain exits
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;
      redis._zsets.set(key, []);
      await advanceVolumeSweepDrain('user_A', 'job-1');

      // Clean exit: drain key removed, no spurious dispatch
      assert.equal(await redis.get(drainKey), null, 'drain cleaned after zero-count completion');
      assert.equal(invoke.mock.callCount(), 1, 'no extra dispatch at zero');
    });

    it('multi-round drain: each completion chains to next batch', async () => {
      const redis = createFakeRedis();
      const invoke = createJobInvoke();
      setup(redis, invoke);
      await populateEpisodes(redis, 'user_A', 200);
      const key = `${UNCLASSIFIED_KEY_PREFIX}user_A`;

      await checkAndTriggerVolumeSweep('user_A');
      assert.equal(invoke.mock.callCount(), 1);

      // Round 2
      redis._zsets.get(key).splice(0, 10);
      await advanceVolumeSweepDrain('user_A', 'job-1');
      assert.equal(invoke.mock.callCount(), 2);

      // Round 3
      redis._zsets.get(key).splice(0, 10);
      await advanceVolumeSweepDrain('user_A', 'job-2');
      assert.equal(invoke.mock.callCount(), 3);

      const drain = JSON.parse(await redis.get(`${SWEEP_DRAIN_KEY_PREFIX}user_A`));
      assert.equal(drain.round, 3);
      assert.equal(drain.jobId, 'job-3');
    });
  });

  // -- Constants validation -----------------------------------------------

  describe('exported constants', () => {
    it('threshold is 200', () => assert.equal(SWEEP_VOLUME_THRESHOLD, 200));
    it('initial interval is 6h', () => assert.equal(SWEEP_MIN_INTERVAL_SECONDS, 21600));
    it('drain interval is 10min', () => assert.equal(SWEEP_DRAIN_INTERVAL_SECONDS, 600));
    it('drain TTL is 20min', () => assert.equal(SWEEP_DRAIN_TTL_SECONDS, 1200));
    it('max drain rounds is 25', () => assert.equal(SWEEP_MAX_DRAIN_ROUNDS, 25));
    it('batch size is 10', () => assert.equal(SWEEP_BATCH_SIZE, 10));
  });
});
