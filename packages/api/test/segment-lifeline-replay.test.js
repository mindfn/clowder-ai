/**
 * F257 Console 判据④ — Segment lifeline true-scene replay route tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

// ── Minimal FakeRedis with SET/ZSET support ──────────────────

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
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

  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key) {
    const s = this.sets.get(key);
    return s ? [...s] : [];
  }
}

// ── Helpers ──────────────────────────────────────────────────

function makeDetail({ threadId, turnId, catId = 'opus', timestamp = 5000, segments }) {
  return {
    turnId,
    threadId,
    catId,
    timestamp,
    sessionContentHash: null,
    turnContentHash: null,
    sessionCharCount: 0,
    sessionTokenEstimate: 0,
    turnCharCount: 0,
    turnTokenEstimate: 0,
    segments,
  };
}

function makeSummary({ threadId, turnId, catId = 'opus', timestamp = 5000, segments }) {
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

function makeSegment(segmentId, overrides = {}) {
  return {
    segmentId,
    stage: 'session-init',
    status: 'observed',
    contentHash: 'hash-1',
    charCount: 100,
    tokenEstimate: 25,
    version: 1,
    pipelineStatus: 'fired',
    content: 'rendered content',
    templateRef: 'templates/S-test.md',
    templateVars: { VAR: 'value' },
    ...overrides,
  };
}

async function buildReplayApp(opts = {}) {
  const { segmentLifelineReplayRoutes } = await import('../dist/routes/segment-lifeline-replay.js');
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(segmentLifelineReplayRoutes, opts);
  await app.ready();
  return app;
}

const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

// ── Route tests ──────────────────────────────────────────────

describe('segment-lifeline-replay route', () => {
  test('returns 401 without session', async () => {
    const app = await buildReplayApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('returns 400 when threadId or turnId missing', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    const app = await buildReplayApp({ traceStore: store });

    const missingThread = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(missingThread.statusCode, 400);

    const missingTurn = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t',
      headers: SESSION_HEADERS,
    });
    assert.equal(missingTurn.statusCode, 400);

    await app.close();
  });

  test('returns 503 when trace store unavailable', async () => {
    const app = await buildReplayApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });

  test('returns 404 when trace detail not found', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    const app = await buildReplayApp({ traceStore: store });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns 404 when segment not observed in turn', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const detail = makeDetail({ threadId: 't', turnId: '1', segments: [makeSegment('S-other')] });
    const summary = makeSummary({ threadId: 't', turnId: '1', segments: [makeSegment('S-other')] });
    await store.persist(summary, detail);

    const app = await buildReplayApp({ traceStore: store });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns full replay payload with content, template, vars, guard events, messages', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { GuardRejectionEventLog } = await import('../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);
    const guardLog = new GuardRejectionEventLog(redis);
    const messageStore = new MessageStore();

    const timestamp = 5000;
    const segment = makeSegment('S-test', { timestamp });
    const detail = makeDetail({ threadId: 't', turnId: '1', catId: 'opus', timestamp, segments: [segment] });
    const summary = makeSummary({ threadId: 't', turnId: '1', catId: 'opus', timestamp, segments: [segment] });
    await traceStore.persist(summary, detail);

    await guardLog.append({
      eventId: 'g1',
      ledgerId: 'layer/g1',
      kind: 'http_rate_limit',
      threadId: 't',
      catId: 'opus',
      guardId: 'hold_ball_rate_limit',
      invocationId: 'inv-1',
      sourceTool: 'hold_ball',
      normalizedReason: 'rate_limited',
      layer: 'api-route',
      ownerUserId: 'test-user',
      timestamp: timestamp + 1000,
      correlationConfidence: 'window',
      currentCount: 4,
      maxAllowed: 3,
      windowMs: 3600000,
    });

    messageStore.append({
      userId: 'u1',
      threadId: 't',
      catId: null,
      content: 'hello',
      mentions: [],
      timestamp: timestamp - 1000,
      provenance: { author: 'user', routed: false, observation: 'original' },
    });
    messageStore.append({
      userId: 'u1',
      threadId: 't',
      catId: 'opus',
      content: 'response text',
      mentions: [],
      timestamp: timestamp + 500,
      provenance: { author: 'cat', routed: false, observation: 'original' },
    });

    const app = await buildReplayApp({ traceStore, guardRejectionLog: guardLog, messageStore });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);

    assert.equal(body.segmentId, 'S-test');
    assert.equal(body.threadId, 't');
    assert.equal(body.turnId, '1');
    assert.equal(body.catId, 'opus');
    assert.equal(body.timestamp, timestamp);
    assert.equal(body.stage, 'session-init');
    assert.equal(body.pipelineStatus, 'fired');
    assert.equal(body.version, 1);
    assert.equal(body.versionGap, null);
    assert.equal(body.content, 'rendered content');
    assert.equal(body.contentGap, null);
    assert.equal(body.templateRef, 'templates/S-test.md');
    assert.equal(body.templateRefGap, null);
    assert.deepEqual(body.templateVars, { VAR: 'value' });
    assert.equal(body.templateVarsGap, null);

    assert.equal(body.guardEvents.length, 1);
    assert.equal(body.guardEvents[0].kind, 'http_rate_limit');
    assert.equal(body.guardEvents[0].guardId, 'hold_ball_rate_limit');

    assert.equal(body.surroundingMessages?.length, 2);
    assert.equal(body.surroundingMessagesGap, null);
    assert.equal(body.surroundingMessages[0].role, 'user');
    assert.equal(body.surroundingMessages[1].role, 'assistant');

    await app.close();
  });

  test('marks undefined fields as legacy-missing gaps', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const timestamp = 5000;
    const segment = makeSegment('S-test', {
      content: undefined,
      templateRef: undefined,
      templateVars: undefined,
      version: undefined,
    });
    const detail = makeDetail({ threadId: 't', turnId: '1', timestamp, segments: [segment] });
    const summary = makeSummary({ threadId: 't', turnId: '1', timestamp, segments: [segment] });
    await traceStore.persist(summary, detail);

    const app = await buildReplayApp({ traceStore });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.contentGap, 'legacy-missing');
    assert.equal(body.templateRefGap, 'legacy-missing');
    assert.equal(body.templateVarsGap, 'legacy-missing');
    assert.equal(body.versionGap, 'legacy-missing');
    assert.equal(body.surroundingMessagesGap, 'unavailable');
    assert.equal(body.guardEventsGap, 'unavailable');

    await app.close();
  });

  test('marks malformed fields as invalid-present gaps', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const timestamp = 5000;
    const segment = makeSegment('S-test', {
      version: 'not-a-number',
      templateVars: ['not-an-object'],
    });
    const detail = makeDetail({ threadId: 't', turnId: '1', timestamp, segments: [segment] });
    const summary = makeSummary({ threadId: 't', turnId: '1', timestamp, segments: [segment] });
    await traceStore.persist(summary, detail);

    const app = await buildReplayApp({ traceStore });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.versionGap, 'invalid-present');
    assert.equal(body.templateVarsGap, 'invalid-present');

    await app.close();
  });
});
