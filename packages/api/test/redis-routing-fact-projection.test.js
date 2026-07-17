/**
 * F257 V1 — RoutingDecisionFact projection tests (§4.5.1 contract).
 *
 * Semantics single source of truth: F257 redesign doc §4.5.1 (projection
 * coverage contract) + T-A §3.4 (metric columns via routing-attempt.ts).
 * 有 Redis → 测全量；无 Redis → skip（与 redis-message-store.test.js 同模式）。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257';
// Per-file keyPrefix: hard keyspace isolation from concurrently running test
// files (cleanupClientKeyspace precedent — cohort reads join timeline↔hash,
// so another file's `msg:*` wildcard cleanup mid-test corrupts the audit).
const TEST_KEY_PREFIX = 'cat-cafe:f257proj:';

function a2aBatch(overrides = {}) {
  return {
    parserMode: 'a2a',
    spanBasis: 'a2a_normalized',
    attempts: [
      { tokenOrdinal: 0, outcome: 'resolved', token: '@codex', span: { start: 0, end: 6 }, targetCatId: 'codex' },
      { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zzz', span: { start: 7, end: 11 } },
      { tokenOrdinal: 2, outcome: 'duplicate', token: '@缅因猫', span: { start: 12, end: 16 }, targetCatId: 'codex' },
    ],
    truncated: false,
    metricEligible: true,
    ...overrides,
  };
}

function userBatch(overrides = {}) {
  return {
    parserMode: 'user',
    spanBasis: 'lowercased_message',
    attempts: [
      { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
    ],
    truncated: false,
    metricEligible: true,
    ...overrides,
  };
}

describe('F257 V1: RedisRoutingFactProjection', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let store;
  let projection;
  let redis;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisRoutingFactProjection');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const projModule = await import('../dist/domains/cats/services/stores/redis/RedisRoutingFactProjection.js');
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    store = new storeModule.RedisMessageStore(redis);
    projection = new projModule.RedisRoutingFactProjection(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
  });

  async function appendFactMessage(batch, timestamp) {
    return store.append({
      userId: OWNER,
      catId: batch.parserMode === 'a2a' ? 'opus' : null,
      content: 'seed',
      mentions: [],
      timestamp,
      threadId: 'th-f257-proj',
      routingFact: batch,
      // sol R3 P1-1: writer-declared two-axis provenance
      provenance: { author: batch.parserMode === 'a2a' ? 'cat' : 'user', routed: true },
    });
  }

  it('project() indexes a fact message and advances the watermark monotonically', async () => {
    const now = Date.now();
    const m1 = await appendFactMessage(a2aBatch(), now - 1000);
    const m2 = await appendFactMessage(userBatch(), now);
    // project out of order — watermark must end at the max id
    await projection.project(m2);
    await projection.project(m1);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 2000, now + 1);
    assert.deepEqual(new Set(members), new Set([m1.id, m2.id]));
    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, m2.id > m1.id ? m2.id : m1.id);
    const health = await projection.getHealth(OWNER);
    assert.equal(health.ok, true);
    assert.equal(health.errorCount, 0);
  });

  it('project() is a no-op for messages without a fact', async () => {
    const now = Date.now();
    const msg = await store.append({
      userId: OWNER,
      catId: null,
      content: 'no tokens',
      mentions: [],
      timestamp: now,
      threadId: 'th-f257-proj',
    });
    await projection.project(msg);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1, now + 1);
    assert.deepEqual(members, []);
  });

  it('reconcileWindow() rebuilds missing projection entries from authority records (idempotent)', async () => {
    const now = Date.now();
    await appendFactMessage(a2aBatch(), now - 500);
    await appendFactMessage(userBatch(), now - 400);
    // briefing-origin messages are outside the routable cohort — no fact expected
    await store.append({
      userId: OWNER,
      catId: null,
      content: 'no fact',
      mentions: [],
      timestamp: now - 300,
      threadId: 'th-f257-proj',
      origin: 'briefing',
    });

    // No projector ran — projection is empty; reconcile must rebuild from authority.
    const first = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(first.ok, true);
    assert.equal(first.cohortCount, 2, 'briefing message is out of cohort');
    assert.equal(first.authorityCount, 2);
    assert.equal(first.producerGapCount, 0);
    assert.equal(first.repairedMissing, 2);
    assert.equal(first.removedStale, 0);

    const second = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(second.ok, true);
    assert.equal(second.repairedMissing, 0, 'idempotent — nothing left to repair');
    assert.equal(second.projectedCount, 2);
  });

  it('reconcileWindow() flags a routed message without a fact as a producer gap (sol R1/R3 P1-1)', async () => {
    const now = Date.now();
    await appendFactMessage(userBatch(), now - 500);
    // The append boundary enforces routed ⇔ fact, so a gap can only come from an
    // out-of-band write or a broken producer — simulate one by corrupting the
    // provenance field after a legal surface append.
    const broken = await store.append({
      userId: OWNER,
      catId: null,
      content: '@opus 看下',
      mentions: ['opus'],
      timestamp: now - 400,
      threadId: 'th-f257-proj',
      provenance: { author: 'user', routed: false },
    });
    await redis.hset(`msg:${broken.id}`, { provenance: JSON.stringify({ author: 'user', routed: true }) });

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false, 'producer gap must not report a healthy window');
    assert.equal(coverage.reason, 'producer_gap');
    assert.equal(coverage.cohortCount, 2);
    assert.equal(coverage.authorityCount, 1);
    assert.equal(coverage.producerGapCount, 1);

    const rate = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(rate.unmeasurable, true);
    assert.equal(rate.reason, 'producer_gap');
    assert.equal(rate.coverage.producerGapCount, 1);
  });

  it('surface messages without a routed lane are out of cohort (sol R2 P1-1 repro)', async () => {
    const now = Date.now();
    await appendFactMessage(userBatch(), now - 500);
    // sol repro: a normal proposal rich card — owner userId, catId null, no
    // source, NO lane declaration — previously misjudged as a producer gap.
    await store.append({
      userId: OWNER,
      catId: null,
      content: '📋 新 thread 提案卡片',
      mentions: [],
      timestamp: now - 450,
      threadId: 'th-f257-proj',
      extra: { rich: { v: 1, blocks: [] } },
    });
    // system-notice shape (source-carrying), also lane-less
    await store.append({
      userId: OWNER,
      catId: null,
      content: '服务刚重启，请重新发送。',
      mentions: [],
      timestamp: now - 400,
      threadId: 'th-f257-proj',
      source: { connector: 'startup-reconciler', label: '重启提醒', icon: '🔄' },
    });

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, true, 'surface messages must not count as producer gaps');
    assert.equal(coverage.cohortCount, 1, 'only the routed-lane message is in cohort');
    assert.equal(coverage.producerGapCount, 0);

    const rate = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(rate.unmeasurable, false, 'window with surface messages stays measurable');
  });

  it('zero-token batches persist and count as authority (producer-run marker, sol R1 P1-1)', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch({ attempts: [] }), now - 200);
    await projection.project(msg);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 300, now);
    assert.deepEqual(members, [msg.id], 'empty batch is indexed');

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, true);
    assert.equal(coverage.cohortCount, 1);
    assert.equal(coverage.authorityCount, 1);
    assert.equal(coverage.producerGapCount, 0);
  });

  it('reconcileWindow() removes stale projection members with no authority record', async () => {
    const now = Date.now();
    await redis.zadd(`routing-fact:idx:${OWNER}`, String(now - 100), 'ghost-message-id');
    const result = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(result.ok, true);
    assert.equal(result.removedStale, 1);
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1000, now);
    assert.deepEqual(members, []);
  });

  it('computeResolutionRate() aggregates per parserMode per T-A columns, excluding ineligible batches', async () => {
    const now = Date.now();
    // a2a: eligible attempts = resolved + unknown_token (duplicate excluded) → 1/2
    await appendFactMessage(a2aBatch(), now - 900);
    // user: resolved → 1/1
    await appendFactMessage(userBatch(), now - 800);
    // truncated a2a batch (metricEligible=false) — excluded entirely per T-A (右截断)
    await appendFactMessage(a2aBatch({ truncated: true, metricEligible: false }), now - 700);

    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.modes.a2a.numerator, 1);
    assert.equal(result.modes.a2a.denominator, 2);
    assert.equal(result.modes.a2a.rate, 0.5);
    assert.equal(result.modes.a2a.batches, 1);
    assert.equal(result.modes.user.numerator, 1);
    assert.equal(result.modes.user.denominator, 1);
    assert.equal(result.modes.user.rate, 1);
    assert.equal(result.excludedBatches, 1);
    assert.equal(result.malformedFacts, 0);
    assert.equal(result.coverage.authorityCount, 3, 'coverage counts all fact-carrying messages');
  });

  it('computeResolutionRate() reports empty windows as measurable with null rates', async () => {
    const now = Date.now();
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.modes.a2a.rate, null);
    assert.equal(result.modes.user.rate, null);
    assert.equal(result.modes.a2a.denominator, 0);
  });

  it('RedisMessageStore append() drives the wired projector automatically', async () => {
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const wiredStore = new storeModule.RedisMessageStore(redis, { routingFactProjection: projection });
    const now = Date.now();
    const msg = await wiredStore.append({
      userId: OWNER,
      catId: null,
      content: '@opus 看下',
      mentions: ['opus'],
      timestamp: now,
      threadId: 'th-f257-wired',
      routingFact: userBatch(),
    });
    // project() is fired void — give the microtask queue a beat
    await new Promise((resolve) => setTimeout(resolve, 50));
    const members = await redis.zrangebyscore(`routing-fact:idx:${OWNER}`, now - 1, now + 1);
    assert.deepEqual(members, [msg.id]);
    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, msg.id);
  });

  it('computeResolutionRate() forces unmeasurable when an authority fact is malformed (sol R1 P1-3)', async () => {
    const now = Date.now();
    await appendFactMessage(a2aBatch(), now - 600);
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.hset(`msg:${msg.id}`, { routingFact: '{broken json' });
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, true, 'no partial rate over a half-parseable window');
    assert.equal(result.reason, 'malformed_authority_fact');
    assert.equal(result.malformedFacts, 1);
  });

  it('deep validation rejects parseable-but-invalid facts (unknown outcome → malformed, sol R1 P1-3)', async () => {
    const now = Date.now();
    const invalid = userBatch({
      attempts: [{ tokenOrdinal: 0, outcome: 'not_a_real_outcome', token: '@x', span: { start: 0, end: 2 } }],
    });
    const msg = await appendFactMessage(invalid, now - 500);
    assert.ok(msg.id);
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, true);
    assert.equal(result.reason, 'malformed_authority_fact');
  });

  it('project() surfaces per-command MULTI errors: no watermark advance, error marker written (sol R1 P1-5)', async () => {
    const now = Date.now();
    // Break the index key type so ZADD fails as a per-command error
    await redis.set(`routing-fact:idx:${OWNER}`, 'wrong-type');
    const msg = await appendFactMessage(userBatch(), now - 100);
    await projection.project(msg);

    const watermark = await redis.get(`routing-fact:watermark:${OWNER}`);
    assert.equal(watermark, null, 'watermark must not advance over a failed write');
    const health = await projection.getHealth(OWNER);
    assert.equal(health.errorCount, 1, 'failure lands in the error ZSET (visible)');

    const coverage = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(coverage.ok, false, 'wrong-type index cannot reconcile silently');
  });
});
