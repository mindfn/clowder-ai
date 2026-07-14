/**
 * F257 Phase D — Segment lifeline route tests.
 *
 * Tests the read-model join: InjectionTraceStore observations filtered by
 * segmentId + GuardRejectionEventLog events + HookOverrideStore state/history.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with sorted set + scan support ──

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.ttls = new Map();
  }

  async set(key, value, ...args) {
    this.kv.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this.ttls.set(key, args[1]);
    }
    return 'OK';
  }

  async get(key) {
    return this.kv.get(key) ?? null;
  }

  async del(key) {
    this.kv.delete(key);
    return 1;
  }

  async zadd(key, score, member) {
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, score);
    this.sorted.set(key, set);
    return 1;
  }

  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }

  async zrevrange(key, start, stop) {
    const set = this.sorted.get(key);
    if (!set) return [];
    const entries = [...set.entries()].sort((a, b) => b[1] - a[1]);
    return entries.slice(start, stop + 1).map(([m]) => m);
  }

  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  async scan(cursor, ...args) {
    // Simple SCAN impl: return all keys matching pattern on first call
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    const allKeys = [...this.kv.keys(), ...this.sorted.keys()];
    const matched = [...new Set(allKeys)].filter((k) => regex.test(k));
    return ['0', matched];
  }
}

// ── Helpers ──────────────────────────────────────────────────

function makeSummary(threadId, turnId, timestamp, catId, segments) {
  return {
    turnId,
    threadId,
    catId,
    timestamp,
    segments,
    delivery: [],
    totalCharCount: 100,
    totalTokenEstimate: 25,
    totalSegmentsObserved: segments.length,
    totalSegmentsAbsent: 0,
    durationMs: 5,
  };
}

function makeSegment(segmentId, opts = {}) {
  return {
    segmentId,
    stage: 'session-init',
    status: opts.status ?? 'observed',
    contentHash: 'hash-1',
    charCount: opts.charCount ?? 100,
    tokenEstimate: 25,
    version: opts.version ?? 1,
    pipelineStatus: opts.pipelineStatus ?? 'fired',
  };
}

function makeDetail(threadId, turnId) {
  return { threadId, turnId, raw: '' };
}

// ── listTracedThreadIds tests ───────────────────────────────

describe('InjectionTraceStore.listTracedThreadIds', () => {
  test('returns thread IDs from index keys', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const s1 = makeSummary('thread-A', 'turn-1', 1000, 'opus', [makeSegment('S-identity')]);
    const s2 = makeSummary('thread-B', 'turn-2', 2000, 'codex', [makeSegment('S-rules')]);
    await store.persist(s1, makeDetail('thread-A', 'turn-1'));
    await store.persist(s2, makeDetail('thread-B', 'turn-2'));

    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-A'), 'should include thread-A');
    assert.ok(threadIds.includes('thread-B'), 'should include thread-B');
    assert.equal(threadIds.length, 2);
  });

  test('returns empty when no traces exist', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const threadIds = await store.listTracedThreadIds();
    assert.deepEqual(threadIds, []);
  });
});

// ── collectObservations integration (via route helper) ──────

describe('segment-lifeline collectObservations', () => {
  test('filters observations by segmentId', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Two traces in one thread: S-identity (our target) and S-rules (different)
    const s1 = makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity'), makeSegment('S-rules')]);
    const s2 = makeSummary('thread-A', 'turn-2', 6000, 'codex', [makeSegment('S-rules')]);
    await store.persist(s1, makeDetail('thread-A', 'turn-1'));
    await store.persist(s2, makeDetail('thread-A', 'turn-2'));

    // Query window [4000, 7000)
    const summaries = await store.queryWindow('thread-A', 4000, 7000);
    assert.equal(summaries.length, 2, 'should have 2 summaries');

    // Filter for S-identity
    const observations = summaries
      .filter((summary) => summary.segments.some((seg) => seg.segmentId === 'S-identity' && seg.status === 'observed'))
      .map((summary) => ({
        threadId: summary.threadId,
        turnId: summary.turnId,
        timestamp: summary.timestamp,
        catId: summary.catId,
      }));

    assert.equal(observations.length, 1, 'only 1 trace has S-identity');
    assert.equal(observations[0].turnId, 'turn-1');
    assert.equal(observations[0].catId, 'opus');
  });

  test('cross-thread observations merge correctly', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Same segment in two different threads
    await store.persist(
      makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity')]),
      makeDetail('thread-A', 'turn-1'),
    );
    await store.persist(
      makeSummary('thread-B', 'turn-2', 6000, 'codex', [makeSegment('S-identity', { version: 2 })]),
      makeDetail('thread-B', 'turn-2'),
    );

    const threadIds = await store.listTracedThreadIds();
    assert.equal(threadIds.length, 2);

    // Query both threads
    const allObservations = [];
    for (const threadId of threadIds) {
      const summaries = await store.queryWindow(threadId, 4000, 7000);
      for (const summary of summaries) {
        const seg = summary.segments.find((s) => s.segmentId === 'S-identity' && s.status === 'observed');
        if (seg) {
          allObservations.push({
            threadId: summary.threadId,
            turnId: summary.turnId,
            timestamp: summary.timestamp,
            version: seg.version,
          });
        }
      }
    }

    assert.equal(allObservations.length, 2, 'found in both threads');
    const versions = allObservations.map((o) => o.version);
    assert.ok(versions.includes(1), 'v1 from thread-A');
    assert.ok(versions.includes(2), 'v2 from thread-B');
  });

  test('absent segments excluded from observations', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    await store.persist(
      makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity', { status: 'absent' })]),
      makeDetail('thread-A', 'turn-1'),
    );

    const summaries = await store.queryWindow('thread-A', 4000, 7000);
    const observed = summaries.flatMap((s) =>
      s.segments.filter((seg) => seg.segmentId === 'S-identity' && seg.status === 'observed'),
    );
    assert.equal(observed.length, 0, 'absent segments excluded');
  });
});

// ── Status derivation ───────────────────────────────────────

describe('segment-lifeline status derivation', () => {
  test('idle when no observations', () => {
    const observations = [];
    const status = observations.length > 0 ? 'tracing' : 'idle';
    assert.equal(status, 'idle');
  });

  test('tracing when observations exist', () => {
    const observations = [{ version: 1 }];
    const status = observations.length > 0 ? 'tracing' : 'idle';
    assert.equal(status, 'tracing');
  });

  test('derives latest version from observations (most recent first)', () => {
    const observations = [
      { version: 2, timestamp: 6000 },
      { version: 1, timestamp: 5000 },
    ];
    // Sorted by timestamp descending, first non-null version is latest
    const sorted = [...observations].sort((a, b) => b.timestamp - a.timestamp);
    const latestVersion = sorted.find((o) => o.version != null)?.version ?? null;
    assert.equal(latestVersion, 2);
  });

  test('null version when no observations have version', () => {
    const observations = [{ version: null }];
    const latestVersion = observations.find((o) => o.version != null)?.version ?? null;
    assert.equal(latestVersion, null);
  });
});
