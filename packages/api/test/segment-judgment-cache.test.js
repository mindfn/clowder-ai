/**
 * F257 Phase D — SegmentJudgmentCache unit tests.
 *
 * Red tests for review findings:
 *   P1-2: Cache drops segmentVersion from SegmentJudgment
 *   P2-3: No direct tests existed
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with HASH + pipeline support ──────────────────

class FakeRedis {
  constructor() {
    this.hashes = new Map(); // key → Map<field, value>
    this.zsets = new Map(); // key → [{score, member}]
  }

  async hset(key, field, value) {
    const h = this.hashes.get(key) ?? new Map();
    h.set(field, value);
    this.hashes.set(key, h);
    return 1;
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async zadd(key, score, member) {
    const z = this.zsets.get(key) ?? [];
    z.push({ score, member });
    z.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    this.zsets.set(key, z);
    return 1;
  }

  async zrangebyscore(key, min, max, ...args) {
    const z = this.zsets.get(key) ?? [];
    const minN = min === '-inf' ? -Infinity : Number(min);
    const maxN = max === '+inf' ? Infinity : Number(max);
    let filtered = z.filter((e) => e.score >= minN && e.score <= maxN);
    if (args[0] === 'LIMIT') {
      const offset = Number(args[1]);
      const count = Number(args[2]);
      filtered = filtered.slice(offset, offset + count);
    }
    return filtered.map((e) => e.member);
  }

  pipeline() {
    const ops = [];
    const self = this;
    const pipe = {
      hset(key, field, value) {
        ops.push({ op: 'hset', key, field, value });
        return pipe;
      },
      hget(key, field) {
        ops.push({ op: 'hget', key, field });
        return pipe;
      },
      zadd(key, score, member) {
        ops.push({ op: 'zadd', key, score, member });
        return pipe;
      },
      async exec() {
        const results = [];
        for (const op of ops) {
          if (op.op === 'hset') {
            await self.hset(op.key, op.field, op.value);
            results.push([null, 1]);
          } else if (op.op === 'hget') {
            const val = await self.hget(op.key, op.field);
            results.push([null, val]);
          } else if (op.op === 'zadd') {
            await self.zadd(op.key, op.score, op.member);
            results.push([null, 1]);
          }
        }
        return results;
      },
    };
    return pipe;
  }
}

// ── Minimal SegmentJudgment shape (matching segment-judgment-engine) ──

function makeJudgment(partial) {
  return {
    judgmentId: `j-${Math.random().toString(36).slice(2, 8)}`,
    segmentId: 'S1',
    segmentVersion: null,
    window: { startMs: 0, endMs: 1000 },
    verdict: 'alive',
    evidence: {
      injectionCount: { value: 10, how_counted: 'fired-count' },
      violationCount: { value: 0, how_counted: 'event-log' },
      denominatorKind: 'fired-count',
      eventRefs: [],
      correlationConfidence: 'window',
    },
    pressure: { observabilityDeadline: null, nextRequiredAction: null },
    producedBy: { domainId: 'eval:harness-ledger', runId: 'run1', evalCat: 'cat1' },
    ...partial,
  };
}

describe('SegmentJudgmentCache', () => {
  /** @type {import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js').SegmentJudgmentCache} */
  let cache;
  let redis;

  test('setup: import and create cache', async () => {
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    redis = new FakeRedis();
    cache = new mod.SegmentJudgmentCache(redis);
    assert.ok(cache);
  });

  // ── Basic CRUD ───────────────────────────────────────────────

  test('get returns null for unknown segment', async () => {
    const result = await cache.get('unknown');
    assert.equal(result, null);
  });

  test('updateBatch stores and retrieves judgment', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'alive' })]);
    const cached = await cache.get('S1');
    assert.ok(cached);
    assert.equal(cached.segmentId, 'S1');
    assert.equal(cached.verdict, 'alive');
    assert.equal(cached.injectionCount, 10);
    assert.equal(cached.violationCount, 0);
  });

  test('updateBatch overwrites previous entry', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'alive' })]);
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'dormant' })]);
    const cached = await cache.get('S1');
    assert.equal(cached.verdict, 'dormant');
  });

  test('updateBatch with empty array is a no-op', async () => {
    await cache.updateBatch([]); // should not throw
  });

  // ── P1-2: segmentVersion preservation ────────────────────────

  test('segmentVersion is preserved in cache (not dropped)', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S2', segmentVersion: 1, verdict: 'alive' })]);
    const cached = await cache.get('S2');
    assert.ok(cached, 'cached entry should exist');
    assert.equal(cached.segmentVersion, 1, 'segmentVersion must be preserved, not dropped');
  });

  test('segmentVersion=null is preserved (not silently dropped)', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S3', segmentVersion: null, verdict: 'dormant' })]);
    const cached = await cache.get('S3');
    assert.ok(cached);
    assert.equal(cached.segmentVersion, null, 'null segmentVersion should be preserved');
  });

  // ── Batch read ───────────────────────────────────────────────

  test('getBatch returns multiple cached entries', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    await cache.updateBatch([
      makeJudgment({ segmentId: 'A', verdict: 'alive', segmentVersion: 1 }),
      makeJudgment({ segmentId: 'B', verdict: 'dormant', segmentVersion: 2 }),
    ]);

    const batch = await cache.getBatch(['A', 'B', 'missing']);
    assert.equal(batch.size, 2);
    assert.equal(batch.get('A')?.verdict, 'alive');
    assert.equal(batch.get('B')?.verdict, 'dormant');
    assert.equal(batch.has('missing'), false);
  });

  test('getBatch with empty array returns empty map', async () => {
    const batch = await cache.getBatch([]);
    assert.equal(batch.size, 0);
  });

  // ── P1-2: judgment history ──────────────────────────────────

  test('updateBatch appends to history, getHistory returns all in time order', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    // Two separate eval runs for the same segment
    await cache.updateBatch([
      makeJudgment({ segmentId: 'H1', verdict: 'dormant', window: { startMs: 0, endMs: 100 } }),
    ]);
    await cache.updateBatch([
      makeJudgment({ segmentId: 'H1', verdict: 'alive', window: { startMs: 100, endMs: 200 } }),
    ]);

    const history = await cache.getHistory('H1');
    assert.equal(history.length, 2, 'should have 2 history entries');
    assert.equal(history[0].verdict, 'dormant', 'first entry (oldest) is dormant');
    assert.equal(history[0].evaluatedAt, 100);
    assert.equal(history[1].verdict, 'alive', 'second entry (latest) is alive');
    assert.equal(history[1].evaluatedAt, 200);
  });

  test('getHistory returns empty for unknown segment', async () => {
    const history = await cache.getHistory('nonexistent');
    assert.equal(history.length, 0);
  });
});
