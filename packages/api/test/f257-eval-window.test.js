/**
 * F257 #6 slice 6c — 判据② eval window / denominator provenance contract tests.
 *
 * Root cause (static call chain, sol proposal): the lifeline endpoint's
 * `window` is the CURRENT QUERY window; `SegmentJudgment` had the precise
 * eval `window + denominatorKind`, but `CachedJudgment` persisted only
 * counts + `evaluatedAt` — so the UI projected incomparable metrics
 * (tracing(18) from the query window vs eval injectionCount=0 from a
 * historical eval window) into the same context as if contradictory.
 *
 * Contract (sol, source thread 2026-07-22):
 *   - producer-written CachedJudgment MUST carry window + denominatorKind;
 *   - only legacy Redis JSON reads may lack them → explicit null (fail-visible);
 *   - window semantics [startMs, endMs) — evaluatedAt is NOT a window;
 *   - the judgment's OWN eval window must never be replaced by the query window.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

// ── Minimal FakeRedis (InjectionTraceStore needs ZSET/SET/SCAN) ──
class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
  }
  async set(key, value) {
    this.kv.set(key, value);
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
    const s = this.sorted.get(key) ?? new Map();
    s.set(member, score);
    this.sorted.set(key, s);
    return 1;
  }
  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }
  async zrevrange(key, start, stop) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1)
      .map(([m]) => m);
  }
  async zrangebyscore(key, min, max) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .filter(([, sc]) => sc >= min && sc <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(key, member) {
    return this.sorted.get(key)?.delete(member) ? 1 : 0;
  }
  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    for (const m of members) s.add(m);
    this.sets.set(key, s);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async scan(_c, ...args) {
    const i = args.indexOf('MATCH');
    const pat = i >= 0 ? args[i + 1] : '*';
    const rx = new RegExp(`^${pat.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', [...new Set([...this.kv.keys(), ...this.sorted.keys()])].filter((k) => rx.test(k))];
  }
}

const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

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

/** CachedJudgment shape AFTER slice 6c — producer writes carry window + denominatorKind. */
function makeJudgment(segmentId, verdict, evaluatedAt, overrides = {}) {
  return {
    segmentId,
    verdict,
    injectionCount: 10,
    violationCount: 1,
    correlationConfidence: 'window',
    evaluatedAt,
    runId: `run-${verdict}`,
    segmentVersion: 1,
    window: { startMs: evaluatedAt - 86_400_000, endMs: evaluatedAt }, // judgment's OWN 1d eval window
    denominatorKind: 'fired-count',
    ...overrides,
  };
}

async function buildApp({ judgment = null } = {}) {
  const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
  const { segmentLifelineRoutes } = await import('../dist/routes/segment-lifeline.js');
  const redis = new FakeRedis();
  const traceStore = new InjectionTraceStore(redis);
  const now = Date.now();
  await traceStore.persist(makeSummary('thread-A', 'turn-1', now - 1000, 'opus', [makeSegment('S-x')]), {
    threadId: 'thread-A',
    turnId: 'turn-1',
    raw: '',
  });

  const opts = { traceStore };
  if (judgment) {
    opts.judgmentCache = { getHistory: async () => [judgment] };
  }

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const u = request.headers['x-test-session-user'];
    if (typeof u === 'string' && u.trim()) request.sessionUserId = u.trim();
  });
  await app.register(segmentLifelineRoutes, opts);
  await app.ready();
  return app;
}

async function getLifeline(app, segmentId = 'S-x') {
  const res = await app.inject({ method: 'GET', url: `/api/segment-lifeline/${segmentId}`, headers: SESSION_HEADERS });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body);
}

// ── Unit: buildVersionChain judgment attribution ──

describe('判据② chain builder — eval window/denominator attribution', () => {
  async function buildChainWith(judgment) {
    const { buildVersionChain } = await import('../dist/routes/segment-lifeline-chain.js');
    return buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      judgmentHistory: [judgment],
      currentContentVersion: null,
    });
  }

  test('epoch.eval carries the judgment OWN window + denominatorKind', async () => {
    const j = makeJudgment('S-x', 'alive', 9_000_000);
    const { chain } = await buildChainWith(j);
    const ev = chain[0].eval;
    assert.ok(ev, 'eval stage should be attached');
    assert.deepEqual(ev.evalWindow, { startMs: 9_000_000 - 86_400_000, endMs: 9_000_000 });
    assert.equal(ev.denominatorKind, 'fired-count');
    assert.equal(ev.evaluatedAt, 9_000_000, 'evaluatedAt preserved as point-in-time, not a window');
  });

  test('legacy judgment (window/denominatorKind undefined) → explicit null, never guessed', async () => {
    const legacy = makeJudgment('S-x', 'alive', 9_000_000);
    delete legacy.window;
    delete legacy.denominatorKind;
    const { chain } = await buildChainWith(legacy);
    const ev = chain[0].eval;
    assert.ok(ev);
    assert.equal(ev.evalWindow, null, 'missing window must surface as null, not derived from evaluatedAt');
    assert.equal(ev.denominatorKind, null, 'missing denominatorKind must surface as null');
  });

  test('per-version attribution: two judgments keep their own windows on their own epochs', async () => {
    const { buildVersionChain } = await import('../dist/routes/segment-lifeline-chain.js');
    const v1Judgment = makeJudgment('S-x', 'dormant', 5_000_000, { segmentVersion: 1 });
    const v2Judgment = makeJudgment('S-x', 'alive', 9_000_000, {
      segmentVersion: 2,
      window: { startMs: 9_000_000 - 3_600_000, endMs: 9_000_000 }, // v2 used a 1h eval window
    });
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        {
          eventId: 'e1',
          hookId: 'S-x',
          action: 'content-set',
          timestamp: 6_000_000,
          actorId: 'system',
          source: 'system',
          epochVersion: 2,
          contentVersion: 2,
        },
      ],
      observations: [],
      judgmentHistory: [v1Judgment, v2Judgment],
      currentContentVersion: 2,
    });
    const v1 = chain.find((e) => e.version === 1);
    const v2 = chain.find((e) => e.version === 2);
    assert.deepEqual(v1.eval.evalWindow, { startMs: 5_000_000 - 86_400_000, endMs: 5_000_000 });
    assert.deepEqual(v2.eval.evalWindow, { startMs: 9_000_000 - 3_600_000, endMs: 9_000_000 });
  });
});

// ── Route contract: eval window ≠ query window ──

describe('判据② route contract — eval window vs query window', () => {
  test('response.window stays the QUERY window; epoch eval carries the judgment OWN window', async () => {
    const now = Date.now();
    // Judgment evaluated 10 days ago over a 1-day eval window — OUTSIDE the default 7d query window.
    const judgment = makeJudgment('S-x', 'alive', now - 10 * 86_400_000);
    const app = await buildApp({ judgment });
    const body = await getLifeline(app);

    // Query window ≈ [now-7d, now]
    assert.ok(Math.abs(body.window.endMs - now) < 5000, 'response.window.endMs is the query end (~now)');
    assert.ok(body.window.startMs > now - 8 * 86_400_000, 'response.window.startMs is ~7d back');

    const epoch = body.chain.find((e) => e.version === 1);
    assert.ok(epoch.eval, 'eval stage present');
    assert.deepEqual(
      epoch.eval.evalWindow,
      { startMs: now - 11 * 86_400_000, endMs: now - 10 * 86_400_000 },
      'eval window must be the judgment OWN historical window, not the query window',
    );
    assert.equal(epoch.eval.denominatorKind, 'fired-count');
  });

  test('legacy cached judgment → API exposes explicit null provenance gap (fail-visible)', async () => {
    const now = Date.now();
    const legacy = makeJudgment('S-x', 'alive', now - 1000);
    delete legacy.window;
    delete legacy.denominatorKind;
    const app = await buildApp({ judgment: legacy });
    const body = await getLifeline(app);

    const epoch = body.chain.find((e) => e.version === 1);
    assert.ok(epoch.eval);
    assert.equal(epoch.eval.evalWindow, null, 'API must surface the provenance gap, not guess');
    assert.equal(epoch.eval.denominatorKind, null);
  });
});
