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
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257';

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
    redis = redisModule.createRedisClient({ url: REDIS_URL });
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
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'routing-fact:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'routing-fact:*']);
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
    await store.append({
      userId: OWNER,
      catId: null,
      content: 'no fact',
      mentions: [],
      timestamp: now - 300,
      threadId: 'th-f257-proj',
    });

    // No projector ran — projection is empty; reconcile must rebuild from authority.
    const first = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(first.ok, true);
    assert.equal(first.authorityCount, 2, 'only fact-carrying messages count as authority');
    assert.equal(first.repairedMissing, 2);
    assert.equal(first.removedStale, 0);

    const second = await projection.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(second.ok, true);
    assert.equal(second.repairedMissing, 0, 'idempotent — nothing left to repair');
    assert.equal(second.projectedCount, 2);
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

  it('computeResolutionRate() counts malformed authority facts instead of silently dropping them', async () => {
    const now = Date.now();
    const msg = await appendFactMessage(userBatch(), now - 500);
    await redis.hset(`msg:${msg.id}`, { routingFact: '{broken json' });
    const result = await projection.computeResolutionRate(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.malformedFacts, 1);
    assert.equal(result.modes.user.denominator, 0, 'malformed batch contributes nothing');
  });
});
