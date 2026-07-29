/**
 * F257 V1 — cat_cafe_report_harness_signal handler tests.
 *
 * Semantics single source of truth: T-C (§3.6) — sourceAnchor union / 三条服务端
 * 校验 / recordedBy principal 注入 / incidentKey / 幂等；§4.5-2 await-append。
 * messageStore dep 用 fake getById（handler 契约只消费 getById）；ledger 用真
 * Redis store（无 Redis → skip，与 store 测试同模式）。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'owner-f257-rhs';
const RECORDER = 'cat-recorder';

const { handleReportHarnessSignal } = await import(
  '../dist/infrastructure/harness-eval/deviation/report-harness-signal.js'
);

/** Fake message fixtures keyed by id — handler only consumes getById (T-C ①②③素材). */
function fixtureMessages() {
  return new Map(
    Object.entries({
      'msg-user': {
        id: 'msg-user',
        threadId: 'th-1',
        userId: OWNER,
        catId: null,
        content: 'x',
        mentions: [],
        timestamp: 1,
        provenance: { author: 'user', routed: false, observation: 'original' },
      },
      'msg-cat': {
        id: 'msg-cat',
        threadId: 'th-1',
        userId: OWNER,
        catId: 'opus',
        content: 'x',
        mentions: [],
        timestamp: 2,
        provenance: { author: 'cat', routed: false, observation: 'original' },
      },
      'msg-foreign': {
        id: 'msg-foreign',
        threadId: 'th-9',
        userId: 'owner-other',
        catId: null,
        content: 'x',
        mentions: [],
        timestamp: 3,
        provenance: { author: 'user', routed: false, observation: 'original' },
      },
      'msg-connector': {
        id: 'msg-connector',
        threadId: 'th-1',
        userId: OWNER,
        catId: null,
        source: { connector: 'telegram', label: 'Telegram', icon: 'telegram' },
        content: 'x',
        mentions: [],
        timestamp: 4,
        provenance: { author: 'external_user', routed: false, observation: 'original' },
      },
      'msg-system': {
        id: 'msg-system',
        threadId: 'th-1',
        userId: OWNER,
        catId: null,
        content: 'x',
        mentions: [],
        timestamp: 5,
        provenance: { author: 'system', routed: false, observation: 'original' },
      },
      'msg-derived-user': {
        id: 'msg-derived-user',
        threadId: 'th-1',
        userId: OWNER,
        catId: null,
        content: 'x',
        mentions: [],
        timestamp: 6,
        provenance: {
          author: 'user',
          routed: false,
          observation: 'derived',
          sourceRef: 'message:msg-user',
        },
      },
      'msg-tombstone': {
        id: 'msg-tombstone',
        threadId: 'th-1',
        userId: OWNER,
        catId: null,
        content: '',
        mentions: [],
        timestamp: 7,
        _tombstone: true,
        provenance: { author: 'user', routed: false, observation: 'original' },
      },
    }),
  );
}

function body(overrides = {}) {
  return {
    sourceAnchor: { kind: 'thread_message', messageId: 'msg-user' },
    subjectCatId: 'cat-subject',
    source: 'peer',
    note: 'observed deviation',
    attributions: [
      { objectiveId: 'obj-routing-delivery', unitRefs: [{ unitType: 'segment', unitId: 'S1' }], weight: 0.8 },
    ],
    ...overrides,
  };
}

describe('F257 V1: handleReportHarnessSignal (T-C 契约)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let deviationLog;
  let redis;
  let connected = false;
  let messages;
  const principal = { userId: OWNER, catId: RECORDER };

  async function call(b, p = principal) {
    return handleReportHarnessSignal(
      { messageStore: { getById: (id) => messages.get(id) ?? null }, deviationLog },
      p,
      b,
    );
  }

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'handleReportHarnessSignal');
    const mod = await import('../dist/infrastructure/harness-eval/deviation/DeviationEventLog.js');
    const redisModule = await import('@cat-cafe/shared/utils');
    redis = redisModule.createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      await redis.quit().catch(() => {});
      return;
    }
    deviationLog = new mod.RedisDeviationEventLog(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, [`deviation:*:${OWNER}`]);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // owner-scoped cleanup —— 与 deviation-event-log.test.js 并发跑互不干扰
    await cleanupPrefixedRedisKeys(redis, [`deviation:*:${OWNER}`]);
    messages = fixtureMessages();
  });

  it('happy path: peer observation on same-owner message → appended, principal 注入', async () => {
    const res = await call(body());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome, 'appended');
    assert.ok(res.body.eventId);
    assert.ok(res.body.incidentKey);

    const q = await deviationLog.query({ ownerUserId: OWNER });
    assert.equal(q.events.length, 1);
    const evt = q.events[0];
    assert.equal(evt.kind, 'manual_observation');
    assert.equal(evt.recordedBy, RECORDER, 'recordedBy = principal.catId（不可自报）');
    assert.equal(evt.ownerUserId, OWNER, 'ownerUserId = principal.userId（server-trusted）');
    assert.equal(evt.subjectCatId, 'cat-subject');
    assert.equal(evt.source, 'peer');
    assert.deepEqual(evt.anchors, { threadId: 'th-1', messageId: 'msg-user' });
    assert.deepEqual(evt.sourceAnchor, { kind: 'thread_message', messageId: 'msg-user' });
  });

  it('校验①: anchor 实体不存在 → 404（含 tombstone —— 内容已 wipe 不可作证据锚）', async () => {
    const missing = await call(body({ sourceAnchor: { kind: 'thread_message', messageId: 'msg-nope' } }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'anchor_not_found');

    const tomb = await call(body({ sourceAnchor: { kind: 'thread_message', messageId: 'msg-tombstone' } }));
    assert.equal(tomb.status, 404);
    assert.equal(tomb.body.error, 'anchor_not_found');
  });

  it('校验②: anchor 与 authenticated owner 不同域 → 403', async () => {
    const res = await call(body({ sourceAnchor: { kind: 'thread_message', messageId: 'msg-foreign' } }));
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'anchor_owner_mismatch');
    assert.equal(await deviationLog.countInWindow(OWNER, 0, Date.now() + 1000), 0);
  });

  it('校验③: source=operator 时 anchor 作者必须为 operator', async () => {
    const catAuthored = await call(
      body({ source: 'operator', sourceAnchor: { kind: 'thread_message', messageId: 'msg-cat' } }),
    );
    assert.equal(catAuthored.status, 403);
    assert.equal(catAuthored.body.error, 'anchor_author_not_operator');

    const connector = await call(
      body({ source: 'operator', sourceAnchor: { kind: 'thread_message', messageId: 'msg-connector' } }),
    );
    assert.equal(connector.status, 403, 'connector 消息 (catId=null, source present) 不是 operator 手笔');

    const system = await call(
      body({ source: 'operator', sourceAnchor: { kind: 'thread_message', messageId: 'msg-system' } }),
    );
    assert.equal(system.status, 403, 'catId=null 不能把 provenance.author=system 冒充成 operator');

    const derived = await call(
      body({ source: 'operator', sourceAnchor: { kind: 'thread_message', messageId: 'msg-derived-user' } }),
    );
    assert.equal(derived.status, 403, '派生的 user 上下文不是新的 operator assertion');

    const ok = await call(body({ source: 'operator' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.outcome, 'appended');
  });

  it('source≠operator 时 cat-authored anchor 合法（③ 只约束 operator source）', async () => {
    const res = await call(body({ sourceAnchor: { kind: 'thread_message', messageId: 'msg-cat' } }));
    assert.equal(res.status, 200);
  });

  it('operator_confirmation anchor: V1 无 confirmation 存储 → 404（候选转正通道未落地）', async () => {
    const res = await call(body({ sourceAnchor: { kind: 'operator_confirmation', confirmationId: 'conf-1' } }));
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'anchor_not_found');
  });

  it('重复 incident → 200 outcome=incident_claimed + 原 eventId（显式去重不静默）', async () => {
    const first = await call(body());
    assert.equal(first.body.outcome, 'appended');
    const dup = await call(
      body({
        note: 'same incident, different wording',
        attributions: [
          { objectiveId: 'obj-routing-delivery', unitRefs: [{ unitType: 'segment', unitId: 'S1' }], weight: 0.3 },
        ],
      }),
    );
    assert.equal(dup.status, 200);
    assert.equal(dup.body.outcome, 'incident_claimed');
    assert.equal(dup.body.eventId, first.body.eventId);
    assert.equal(await deviationLog.countInWindow(OWNER, 0, Date.now() + 1000), 1);
  });

  it('idempotencyKey 网络重试 → idempotent_replay 同 eventId（principal+thread scoped）', async () => {
    const first = await call(body({ idempotencyKey: 'retry-42' }));
    assert.equal(first.body.outcome, 'appended');
    const retry = await call(body({ idempotencyKey: 'retry-42' }));
    assert.equal(retry.body.outcome, 'idempotent_replay');
    assert.equal(retry.body.eventId, first.body.eventId);

    // 不同 principal 的同名 idempotencyKey 不共享（scope 隔离）——但同 incident 仍被 claim 挡住
    const otherCat = await call(body({ idempotencyKey: 'retry-42' }), { userId: OWNER, catId: 'cat-other' });
    assert.equal(otherCat.body.outcome, 'incident_claimed');
  });

  it('body 校验失败 → 400 invalid_body（weight 越界 / 未知字段即 spoof 尝试 / anchor 形状错）', async () => {
    const badWeight = await call(
      body({ attributions: [{ objectiveId: 'o', unitRefs: [{ unitType: 'segment', unitId: 'S1' }], weight: 0 }] }),
    );
    assert.equal(badWeight.status, 400);
    assert.equal(badWeight.body.error, 'invalid_body');

    const spoof = await call(body({ recordedBy: 'cat-imposter' }));
    assert.equal(spoof.status, 400, 'recordedBy 不是输入字段——出现即拒（T-C 不可自报）');

    const badAnchor = await call(body({ sourceAnchor: { kind: 'thread_message' } }));
    assert.equal(badAnchor.status, 400);

    const badSource = await call(body({ source: 'llm' }));
    assert.equal(badSource.status, 400);
  });
});
