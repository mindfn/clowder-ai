/**
 * F257 V1 — magic word 词面出现数 metric tests (T-B §3.5 contract).
 *
 * Semantics single source of truth: F257 redesign doc T-B (§3.5).
 * Event Memory = single source of truth (in-memory SQLite here); Redis carries
 * the message authority + watermark (isolated redis suite pattern).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257-mw';
// Per-file keyPrefix: hard keyspace isolation from concurrently running test
// files (cleanupClientKeyspace precedent — cross-file `msg:*` wildcard cleanup
// races with the strict missing-hash contract otherwise).
const TEST_KEY_PREFIX = 'cat-cafe:f257mw:';

describe('F257 V1: MagicWordMetricService (T-B)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let eventMemory;
  let service;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'MagicWordMetricService');
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
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
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupClientKeyspace(redis);
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
      provenance: { author: 'user', routed: false, observation: 'original' }, // sol R3 P1-2: author axis selects the cohort
      ...extra,
    });
  }

  it('sol R4 P1-1c: malformed provenance -> unmeasurable window; absent legacy -> out of cohort only', async () => {
    const now = Date.now();
    const bad = await appendUserMessage('这个方案绕路了', now - 500);
    await appendUserMessage('正常消息 第一性原理', now - 400);
    // storage fault repro (sol R4): corrupt the persisted declaration
    await redis.hset(`msg:${bad.id}`, 'provenance', '{"author":"user"');

    const rec = await service.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(rec.ok, false, 'corrupt declaration is a collection gap, not a smaller cohort');
    const counts = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(counts.unmeasurable, true, 'exact metric must refuse to report over a corrupt window');

    // absent (legacy pre-contract) is a DIFFERENT fact: measurable, message out of cohort
    await redis.hdel(`msg:${bad.id}`, 'provenance');
    const rec2 = await service.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(rec2.ok, true);
    assert.equal(rec2.scanned, 1, 'legacy message honestly out of cohort');
  });

  it('R5: author/catId contradictions and empty provenance make the window unmeasurable', async () => {
    const now = Date.now();
    const bad = await appendUserMessage('这个方案绕路了', now - 500);
    await redis.hset(`msg:${bad.id}`, {
      catId: 'opus',
      provenance: JSON.stringify({ author: 'user', routed: false, observation: 'original' }),
    });
    const contradicted = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(contradicted.unmeasurable, true, 'cat text cannot masquerade as an operator observation');

    await redis.hset(`msg:${bad.id}`, { catId: '', provenance: '' });
    const empty = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(empty.unmeasurable, true, 'present-but-empty provenance is storage corruption, not legacy absence');
  });

  it('R6: missing/non-numeric timestamp and missing content fail closed', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('这个方案绕路了', now - 500);

    await redis.hdel(`msg:${msg.id}`, 'timestamp');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'timestamp', 'not-a-number');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'timestamp', String(now - 500));
    await redis.hdel(`msg:${msg.id}`, 'content');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'content', '这个方案绕路了');
    await redis.hdel(`msg:${msg.id}`, 'catId');
    assert.equal(
      (await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable,
      true,
      'catId is nullable in meaning but the persisted field itself is required',
    );
  });

  it('R6: hash id/owner/timestamp must match the owner timeline coordinates', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('这个方案绕路了', now - 500);

    await redis.hset(`msg:${msg.id}`, 'id', 'different-message-id');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, { id: msg.id, userId: 'different-owner' });
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'userId', OWNER);
    await redis.zadd(`msg:user:${OWNER}`, String(now - 400), msg.id);
    assert.equal(
      (await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable,
      true,
      'timeline score and authority timestamp disagreement is corruption',
    );
  });

  it('R6: malformed mentions/source/routingFact payloads fail closed', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('这个方案绕路了', now - 500);

    await redis.hset(`msg:${msg.id}`, 'mentions', '{');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'mentions', '[]');
    await redis.hset(`msg:${msg.id}`, 'source', '{');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hdel(`msg:${msg.id}`, 'source');
    await redis.hset(`msg:${msg.id}`, {
      routingFact: '',
      provenance: JSON.stringify({ author: 'user', routed: true, observation: 'original' }),
    });
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);

    await redis.hset(`msg:${msg.id}`, 'routingFact', '{');
    assert.equal((await service.computeWordCounts(OWNER, now - 1000, now)).unmeasurable, true);
  });

  it('R6: external connector words are not authenticated-operator metric observations', async () => {
    const now = Date.now();
    await store.append({
      userId: OWNER,
      catId: null,
      content: '这个流程绕路了',
      mentions: [],
      timestamp: now - 500,
      threadId: 'th-f257-mw',
      source: { connector: 'telegram', label: 'Telegram', icon: 'telegram' },
      provenance: { author: 'external_user', routed: false, observation: 'original' },
    });

    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.reconcile.scanned, 0);
    assert.deepEqual(result.counts, {});
  });

  it('R6: branch edit is a new current observation in the branch→metric path', async () => {
    const now = Date.now();
    const sourceThreadId = 'th-f257-mw-old';
    const source = await store.append({
      userId: OWNER,
      catId: null,
      content: '旧消息',
      mentions: [],
      timestamp: now - 86_400_000,
      threadId: sourceThreadId,
      provenance: { author: 'user', routed: false, observation: 'original' },
    });
    const threads = new Map([
      [
        sourceThreadId,
        {
          id: sourceThreadId,
          title: '旧对话',
          projectPath: 'default',
          createdBy: OWNER,
          participants: [],
          createdAt: now - 86_400_000,
          lastActiveAt: now - 86_400_000,
        },
      ],
    ]);
    let branchSeq = 0;
    const threadStore = {
      create(userId, title, projectPath) {
        const thread = {
          id: `th-f257-mw-branch-${++branchSeq}`,
          title,
          projectPath,
          createdBy: userId,
          participants: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        };
        threads.set(thread.id, thread);
        return thread;
      },
      get: (id) => threads.get(id) ?? null,
      addParticipants() {},
      delete: (id) => threads.delete(id),
    };
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {} };
    const { threadBranchRoutes } = await import('../dist/routes/thread-branch.js');
    const app = Fastify();
    await app.register(threadBranchRoutes, { messageStore: store, threadStore, socketManager });
    await app.ready();
    try {
      const requestStartedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: `/api/threads/${sourceThreadId}/branch`,
        payload: { fromMessageId: source.id, editedContent: '这个方案绕路了', userId: OWNER },
      });
      assert.equal(response.statusCode, 201, response.body);

      const result = await service.computeWordCounts(OWNER, requestStartedAt - 1, Date.now() + 1);
      assert.equal(result.unmeasurable, false);
      assert.deepEqual(result.counts, { 绕路了: 1 });
      assert.equal(result.reconcile.scanned, 1);
    } finally {
      await app.close();
    }
  });

  it('R5: derived branch history does not create a second magic-word observation', async () => {
    const now = Date.now();
    const original = await appendUserMessage('这个方案绕路了', now - 600, {
      provenance: { author: 'user', routed: false, observation: 'original' },
    });
    await appendUserMessage('这个方案绕路了', now - 500, {
      provenance: {
        author: 'user',
        routed: false,
        observation: 'derived',
        sourceRef: `message:${original.id}`,
      },
      threadId: 'th-f257-mw-branch',
    });

    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.reconcile.scanned, 1, 'only the original user observation is scanned');
    assert.deepEqual(result.counts, { 绕路了: 1 });
  });

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
    // real stream shape: routed lane + cat author — excluded by authorship
    await store.append({
      userId: OWNER,
      catId: 'opus',
      content: '用户之前说绕路了，我调整了方向',
      mentions: [],
      timestamp: now - 500,
      threadId: 'th-f257-mw',
      provenance: { author: 'cat', routed: false, observation: 'original' },
    });
    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, {});
    assert.equal(result.reconcile.scanned, 0, 'cat messages are not scanned');
  });

  it('non-routed real user messages (game lane) ARE counted (sol R3 P1-2 repro)', async () => {
    const now = Date.now();
    // sol repro: game-lane user message — real operator words, no routing parser ran
    await store.append({
      userId: OWNER,
      catId: null,
      content: '这个流程绕路了',
      mentions: [],
      timestamp: now - 500,
      threadId: 'th-f257-mw',
      provenance: { author: 'user', routed: false, observation: 'original' },
    });
    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.reconcile.scanned, 1, 'author axis selects it regardless of routing');
    assert.deepEqual(result.counts, { 绕路了: 1 });
  });

  it('surface messages quoting a magic word are not operator hits (sol R2 P1-1 repro)', async () => {
    const now = Date.now();
    // sol repro: system relay message — catId null but NOT a routed lane
    await store.append({
      provenance: { author: 'system', routed: false, observation: 'original' },
      userId: OWNER,
      catId: null,
      content: '系统转述：用户之前说绕路了',
      mentions: [],
      timestamp: now - 500,
      threadId: 'th-f257-mw',
      source: { connector: 'relay', label: '转述', icon: '📣' },
    });
    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, false);
    assert.equal(result.reconcile.scanned, 0, 'surface message is not scanned');
    assert.deepEqual(result.counts, {}, 'no operator hit from a system relay');
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

  it('live event with late detection timestamp still counts via message-coordinate join (sol R1 P1-4)', async () => {
    const base = Date.now() - 100_000;
    // sol repro: message at t, live event recorded at t+1000 (detection time),
    // window ends between the two — the hit belongs to the window的 message.
    const msg = await appendUserMessage('这就绕路了', base + 1000);
    eventMemory.markEvent(
      {
        type: '绕路了',
        trigger: 'human_brake',
        cat: 'unknown',
        threadId: 'th-f257-mw',
        messageId: msg.id,
        timestamp: base + 2000, // live path stamps detection time, not message time
        summary: '这就绕路了',
        cognitiveTransition: 'user_brake',
        relatedHarness: null,
        confidence: 'high',
      },
      OWNER,
    );

    const result = await service.computeWordCounts(OWNER, base, base + 1500);
    assert.equal(result.unmeasurable, false);
    assert.deepEqual(result.counts, { 绕路了: 1 }, 'join by message coordinates, not event timestamp');
    assert.equal(result.reconcile.backfilled, 0, 'dedup key already claimed by the live event');
  });

  it('an indexed message with a missing hash forces unmeasurable (sol R1 P1-4)', async () => {
    const now = Date.now();
    const msg = await appendUserMessage('脚手架', now - 500);
    await redis.del(`msg:${msg.id}`); // timeline entry survives, hash gone → collection gap

    const reconcile = await service.reconcileWindow(OWNER, now - 1000, now);
    assert.equal(reconcile.ok, false, 'partial window must not report as reconciled');

    const result = await service.computeWordCounts(OWNER, now - 1000, now);
    assert.equal(result.unmeasurable, true);
    assert.equal(result.reason, 'reconcile_failed');
  });
});
