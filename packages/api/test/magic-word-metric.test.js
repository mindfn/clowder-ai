/**
 * F257 V1 — magic word 词面出现数 metric tests (T-B §3.5 contract).
 *
 * Semantics single source of truth: F257 redesign doc T-B (§3.5).
 * Event Memory = single source of truth (in-memory SQLite here); Redis carries
 * the message authority + watermark (isolated redis suite pattern).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257-mw';

describe('F257 V1: MagicWordMetricService (T-B)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let eventMemory;
  let service;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'MagicWordMetricService');
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    store = new storeModule.RedisMessageStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'magic-word:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'magic-word:*']);
    const emModule = await import('../dist/domains/memory/EventMemoryStore.js');
    eventMemory = new emModule.EventMemoryStore(':memory:');
    await eventMemory.initialize();
    const svcModule = await import('../dist/infrastructure/harness-eval/task-outcome/magic-word-metric.js');
    service = new svcModule.MagicWordMetricService({ redis, eventMemoryStore: eventMemory });
  });

  async function appendUserMessage(content, timestamp, extra = {}) {
    return store.append({
      userId: OWNER,
      catId: null,
      content,
      mentions: [],
      timestamp,
      threadId: 'th-f257-mw',
      ...extra,
    });
  }

  it('reconcile backfills hits the live path missed, with message timestamps (idempotent)', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('这个方案绕路了，回到主线', now - 500);
    await appendUserMessage('普通消息没有词', now - 400);

    const first = await service.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(first.ok, true);
    assert.equal(first.scanned, 2);
    assert.equal(first.backfilled, 1);

    const events = eventMemory.listEvents({ ownerUserId: OWNER });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, '绕路了');
    assert.equal(events[0].messageId, msg.id);
    assert.equal(events[0].timestamp, now - 500, 'event carries the message timestamp, not scan time');

    const second = await service.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(second.backfilled, 0, 'idempotent — markEvent dedups on (owner,thread,msg,word)');

    const watermark = await service.getWatermark(OWNER);
    assert.equal(watermark, now);
  });

  it('computeWordCounts counts unique (message, word) hits per word', async () => {
    const now = Date.now();
    // same word twice in ONE message → 1 unique hit
    await appendUserMessage('绕路了绕路了，你这绕路了', now - 900);
    // same word in a SECOND message → +1
    await appendUserMessage('又绕路了', now - 800);
    // different word → its own count
    await appendUserMessage('这是脚手架吧', now - 700);

    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, { 绕路了: 2, 脚手架: 1 });
    assert.equal(result.total, 3);
    assert.equal(result.reconcile.backfilled, 3);
  });

  it('cat-authored messages are out of cohort', async () => {
    const now = Date.now();
    await store.append({
      userId: OWNER,
      catId: 'opus',
      content: '用户之前说绕路了，我调整了方向',
      mentions: [],
      timestamp: now - 500,
      threadId: 'th-f257-mw',
    });
    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, {});
    assert.equal(result.reconcile.scanned, 0, 'cat messages are not scanned');
  });

  it('live-written events are not double-counted by reconcile', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('第一性原理 砍掉脚手架', now - 500);
    // simulate the live path having already written one of the two hits
    eventMemory.markEvent(
      {
        type: '第一性原理',
        trigger: 'human_brake',
        cat: 'unknown',
        threadId: 'th-f257-mw',
        messageId: msg.id,
        timestamp: now - 500,
        summary: '第一性原理 砍掉脚手架',
        cognitiveTransition: 'user_brake',
        relatedHarness: null,
        confidence: 'high',
      },
      OWNER,
    );

    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, { 第一性原理: 1, 脚手架: 1 });
    assert.equal(result.reconcile.backfilled, 1, 'only the missed hit is backfilled');
  });

  it('window boundaries exclude out-of-window hits', async () => {
    const now = Date.now();
    await appendUserMessage('绕路了', now - 5000);
    await appendUserMessage('脚手架', now - 500);
    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, { 脚手架: 1 });
  });
});
