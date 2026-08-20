/**
 * FakeRedis — Map-backed Redis stub for unit tests.
 *
 * Supports: get/set/del (strings), sadd/srem/smembers (sets),
 * zadd/zrevrange/zcard/zrem (sorted sets).
 * Tracks TTLs via _ttls Map when SET EX is used.
 *
 * Also exports trace event fixtures for injection trace tests.
 *
 * Used by: hook-override-store.test.js, injection-trace-store.test.js
 */

export class FakeRedis {
  /** @type {Map<string, string>} */
  store = new Map();
  /** @type {Map<string, Set<string>>} */
  sets = new Map();
  /** @type {Map<string, Array<{score: number, member: string}>>} */
  sortedSets = new Map();
  /** @type {Map<string, number>} */
  _ttls = new Map();

  // -- String ops -----------------------------------------------------------
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async set(key, value, ...args) {
    this.store.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this._ttls.set(key, args[1]);
    }
    return 'OK';
  }
  async del(key) {
    const had = this.store.has(key);
    this.store.delete(key);
    return had ? 1 : 0;
  }

  // -- Set ops --------------------------------------------------------------
  async sadd(key, member) {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    this.sets.get(key).add(member);
    return 1;
  }
  async srem(key, member) {
    const set = this.sets.get(key);
    if (!set) return 0;
    const had = set.has(member);
    set.delete(member);
    return had ? 1 : 0;
  }
  async smembers(key) {
    const set = this.sets.get(key);
    return set ? [...set] : [];
  }

  // -- Sorted set ops -------------------------------------------------------
  async zadd(key, score, member) {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, []);
    const set = this.sortedSets.get(key);
    const idx = set.findIndex((e) => e.member === member);
    if (idx >= 0) set.splice(idx, 1);
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score);
    return 1;
  }
  async zrevrange(key, start, stop) {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    const reversed = [...set].reverse();
    return reversed.slice(start, stop + 1).map((e) => e.member);
  }
  async zcard(key) {
    return this.sortedSets.get(key)?.length ?? 0;
  }
  async zrem(key, member) {
    const set = this.sortedSets.get(key);
    if (!set) return 0;
    const idx = set.findIndex((e) => e.member === member);
    if (idx >= 0) {
      set.splice(idx, 1);
      return 1;
    }
    return 0;
  }

  async zrangebyscore(key, min, max) {
    const set = this.sortedSets.get(key);
    if (!set) return [];
    return set.filter((e) => e.score >= Number(min) && e.score <= Number(max)).map((e) => e.member);
  }

  // -- Transaction support (simplified ioredis multi/exec) --------------------
  multi() {
    return new FakePipeline(this);
  }
}

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.commands = [];
  }

  set(key, value, ...args) {
    this.commands.push({ op: 'set', key, value, args });
    return this;
  }

  get(key) {
    this.commands.push({ op: 'get', key });
    return this;
  }

  del(key) {
    this.commands.push({ op: 'del', key });
    return this;
  }

  sadd(key, ...members) {
    this.commands.push({ op: 'sadd', key, members });
    return this;
  }

  srem(key, ...members) {
    this.commands.push({ op: 'srem', key, members });
    return this;
  }

  smembers(key) {
    this.commands.push({ op: 'smembers', key });
    return this;
  }

  zadd(key, score, member) {
    this.commands.push({ op: 'zadd', key, score, member });
    return this;
  }

  zrem(key, member) {
    this.commands.push({ op: 'zrem', key, member });
    return this;
  }

  zrevrange(key, start, stop) {
    this.commands.push({ op: 'zrevrange', key, start, stop });
    return this;
  }

  zrangebyscore(key, min, max) {
    this.commands.push({ op: 'zrangebyscore', key, min, max });
    return this;
  }

  zcard(key) {
    this.commands.push({ op: 'zcard', key });
    return this;
  }

  async exec() {
    // Snapshot the Redis state so we can roll back the entire pipeline if any
    // individual command fails. This mirrors the atomicity expectation that the
    // harness evaluation runtime places on MULTI/EXEC (production uses a Lua
    // script or equivalent atomic primitive).
    const rollbackSnapshot = cloneRedisState(this.redis);
    const results = [];
    let errorCount = 0;

    try {
      for (const command of this.commands) {
        try {
          const value = await executePipelineCommand(this.redis, command);
          results.push([null, value]);
        } catch (error) {
          results.push([error, null]);
          errorCount++;
        }
      }
    } catch (error) {
      restoreRedisState(this.redis, rollbackSnapshot);
      throw error;
    }

    if (errorCount > 0) {
      restoreRedisState(this.redis, rollbackSnapshot);
    }
    return results;
  }
}

/** @type {Record<string, (redis: FakeRedis, command: unknown) => Promise<unknown>>} */
const PIPELINE_COMMAND_HANDLERS = {
  set: (redis, command) => redis.set(command.key, command.value, ...command.args),
  get: (redis, command) => redis.get(command.key),
  del: (redis, command) => redis.del(command.key),
  sadd: (redis, command) => runSetAddAll(redis, command.key, command.members),
  srem: (redis, command) => runSetRemoveAll(redis, command.key, command.members),
  smembers: (redis, command) => redis.smembers(command.key),
  zadd: (redis, command) => redis.zadd(command.key, command.score, command.member),
  zrem: (redis, command) => redis.zrem(command.key, command.member),
  zrevrange: (redis, command) => redis.zrevrange(command.key, command.start, command.stop),
  zrangebyscore: (redis, command) => redis.zrangebyscore(command.key, command.min, command.max),
  zcard: (redis, command) => redis.zcard(command.key),
};

async function executePipelineCommand(redis, command) {
  const handler = PIPELINE_COMMAND_HANDLERS[command.op];
  if (!handler) {
    throw new Error(`fake_pipeline_unsupported:${command.op}`);
  }
  return handler(redis, command);
}

async function runSetAddAll(redis, key, members) {
  let added = 0;
  for (const member of members) {
    const before = redis.sets.get(key)?.size ?? 0;
    await redis.sadd(key, member);
    const after = redis.sets.get(key)?.size ?? 0;
    if (after > before) added++;
  }
  return added;
}

async function runSetRemoveAll(redis, key, members) {
  let removed = 0;
  for (const member of members) {
    const before = redis.sets.get(key)?.size ?? 0;
    await redis.srem(key, member);
    const after = redis.sets.get(key)?.size ?? 0;
    if (after < before) removed++;
  }
  return removed;
}

function cloneRedisState(redis) {
  const store = new Map(redis.store);
  const sets = new Map();
  for (const [key, set] of redis.sets) {
    sets.set(key, new Set(set));
  }
  const sortedSets = new Map();
  for (const [key, list] of redis.sortedSets) {
    sortedSets.set(
      key,
      list.map((entry) => ({ ...entry })),
    );
  }
  return { store, sets, sortedSets };
}

function restoreRedisState(redis, snapshot) {
  redis.store = snapshot.store;
  redis.sets = snapshot.sets;
  redis.sortedSets = snapshot.sortedSets;
}

// ---------------------------------------------------------------------------
// Trace event fixtures (used by injection-trace-store.test.js)
// ---------------------------------------------------------------------------

/** @returns {import('@cat-cafe/shared').TraceEvent[]} */
export function makeTraceEvents() {
  return [
    {
      hookId: 'S1',
      stage: 'session-init',
      timestamp: 1000,
      status: 'fired',
      version: 1,
      contentHash: 'abc',
      tokenEstimate: 150,
    },
    {
      hookId: 'S2',
      stage: 'session-init',
      timestamp: 1001,
      status: 'skipped',
      reasonCode: 'no_pack',
      reason: 'No pack blocks',
    },
    { hookId: 'S3', stage: 'session-init', timestamp: 1002, status: 'disabled', disabledBy: 'operator' },
    {
      hookId: 'D1',
      stage: 'per-turn',
      timestamp: 2000,
      status: 'fired',
      version: 1,
      contentHash: 'def',
      tokenEstimate: 80,
    },
    { hookId: 'N2', stage: 'per-turn', timestamp: 2001, status: 'observed', contentHash: 'ghi', tokenEstimate: 200 },
  ];
}

/** Build minimal detail object for testing. */
export function makeDetail(turnId, threadId, catId, events) {
  return { turnId, threadId, catId, timestamp: Date.now(), hooks: events };
}
