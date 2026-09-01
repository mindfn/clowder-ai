/** F257 governance Candidate production CAS contracts against isolated Redis. */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F257 governance CandidateStore - real Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'f257-governance-candidate-store-redis');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { CandidateStore } = await import('../dist/infrastructure/harness-eval/governance/CandidateStore.js');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f257-governance-candidate-store:' });
    await redis.ping();
    store = new CandidateStore(redis);
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  test('concurrent approval settlement converges to one durable closed Candidate', async () => {
    const candidate = fixtureCandidate('EC-redis-approve', 'S13');
    await store.create(candidate, fixtureContext('owner-1'));
    await store.beginApproval(candidate.candidateId, 'owner-1');
    const input = {
      candidateId: candidate.candidateId,
      approvedBy: 'owner-1',
      note: 'operator approved',
      approvedAt: 1_000,
    };
    const outcomes = await Promise.all([store.settleApproval(input), store.settleApproval(input)]);
    assert.ok(outcomes.every((current) => current.status === 'closed'));
    const closed = await store.get(candidate.candidateId);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.approval.approvedBy, 'owner-1');
    assert.equal(closed.approval.note, 'operator approved');
  });

  test('a stale transition cannot reopen a settled Candidate', async () => {
    const candidate = fixtureCandidate('EC-stale-transition', 'S13');
    await store.create(candidate, fixtureContext('owner-1'));
    const executing = await store.beginApproval(candidate.candidateId, 'owner-1');
    await store.settleApproval({
      candidateId: candidate.candidateId,
      approvedBy: 'owner-1',
      note: 'operator approved',
      approvedAt: 1_000,
    });

    assert.equal(
      await store.updateCandidate(executing, { ...executing, status: 'proposed' }),
      false,
      'CAS miss is a no-op after the approval settlement terminalized the Candidate',
    );
    assert.equal((await store.get(candidate.candidateId)).status, 'closed');
    assert.equal(await store.hasOpenIntervention('owner-1', 'S13'), false);
  });

  test('owner/segment indexes cannot collide and concurrent rejection is idempotent', async () => {
    const first = fixtureCandidate('EC-index-first', 'b');
    const second = fixtureCandidate('EC-index-second', 'a:b');
    await store.create(first, fixtureContext('owner:a'));
    await store.create(second, fixtureContext('owner'));

    assert.deepEqual(
      (await store.listBySegment('owner:a', 'b')).map((candidate) => candidate.candidateId),
      [first.candidateId],
    );
    assert.deepEqual(
      (await store.listBySegment('owner', 'a:b')).map((candidate) => candidate.candidateId),
      [second.candidateId],
    );

    const rejection = {
      candidateId: first.candidateId,
      rejectedBy: 'owner:a',
      note: 'operator rejected',
      rejectedAt: 2_000,
    };
    const rejected = await Promise.all([store.reject(rejection), store.reject(rejection)]);
    assert.ok(rejected.every((candidate) => candidate.status === 'rejected'));
    assert.ok(rejected.every((candidate) => candidate.approval.approvedBy === null));
    assert.equal(await store.countPending('owner:a', 'b'), 0);
    assert.equal(await store.countPending('owner', 'a:b'), 1);
  });

  test('corrupt Candidate rows fail closed instead of breaking Hub reads', async () => {
    await redis.hset('harness-governance-candidate', 'EC-corrupt', JSON.stringify({ status: 'proposed' }));
    await redis.sadd('harness-governance-candidate-owner:owner-1', 'EC-corrupt');
    assert.equal(await store.get('EC-corrupt'), null);
    assert.deepEqual(await store.listByOwner('owner-1'), []);
  });

  test('decision lease serializes external approval side effects and releases by token', async () => {
    let enter;
    let release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const first = store.withDecisionLock('EC-redis-lock', async () => {
      enter();
      await blocked;
      return 'first';
    });
    await entered;
    await assert.rejects(
      store.withDecisionLock('EC-redis-lock', async () => 'second'),
      /governance_candidate_concurrent_transition/,
    );
    release();
    assert.equal(await first, 'first');
    assert.equal(await store.withDecisionLock('EC-redis-lock', async () => 'after-release'), 'after-release');
  });

  test('concurrent Objective judgments open at most one intervention for an owner+segment', async () => {
    const first = fixtureCandidate('EC-open-first', 'S13');
    const second = {
      ...fixtureCandidate('EC-open-second', 'S13'),
      evidence: { anchors: ['judgment-2'], summary: 'a concurrent measured breach' },
    };
    const firstContext = fixtureContext('owner-1');
    const secondContext = { ...fixtureContext('owner-1'), judgmentId: 'judgment-2' };

    const outcomes = await Promise.all([
      store.createInterventionIfNone(first, firstContext, 'S13'),
      store.createInterventionIfNone(second, secondContext, 'S13'),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome === 'created').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome === 'blocked').length, 1);
    assert.equal((await store.listBySegment('owner-1', 'S13')).length, 1);
    assert.equal(await store.countPending('owner-1', 'S13'), 1);
  });

  test('legacy trial-era statuses stay readable but do not block the next ordinary eval', async () => {
    const legacy = {
      ...fixtureCandidate('EC-legacy-verifying', 'S13'),
      status: 'verifying',
      approval: { approvedBy: 'owner-1', decidedAt: new Date(100).toISOString(), note: 'legacy approval' },
    };
    await store.create(legacy, fixtureContext('owner-1'));
    const next = {
      ...fixtureCandidate('EC-next-round', 'S13'),
      evidence: { anchors: ['judgment-2'], summary: 'next ordinary eval breach' },
    };
    const nextContext = { ...fixtureContext('owner-1'), judgmentId: 'judgment-2', createdAt: 200 };

    assert.equal(await store.createInterventionIfNone(next, nextContext, 'S13'), 'created');
    assert.equal((await store.get(legacy.candidateId)).status, 'verifying');
    assert.equal(await store.countPending('owner-1', 'S13'), 1);
  });

  test('deterministic replay repairs context and indexes after a partial Candidate write', async () => {
    const candidate = fixtureCandidate('EC-partial-repair', 'S13');
    const settled = {
      ...candidate,
      status: 'rejected',
      approval: { approvedBy: null, decidedAt: new Date(90).toISOString(), note: 'operator rejected' },
    };
    const context = fixtureContext('owner-1');
    await redis.hset('harness-governance-candidate', candidate.candidateId, JSON.stringify(settled));

    assert.equal(await store.createInterventionIfNone(candidate, context, 'S13'), 'duplicate');
    assert.equal((await store.get(candidate.candidateId)).status, 'rejected');
    assert.deepEqual(await store.getEvaluationContext(candidate.candidateId), context);
    assert.deepEqual(
      (await store.listByOwner('owner-1')).map((current) => current.candidateId),
      [candidate.candidateId],
    );
    assert.deepEqual(
      (await store.listBySegment('owner-1', 'S13')).map((current) => current.candidateId),
      [candidate.candidateId],
    );
  });
});

function fixtureCandidate(candidateId, segmentId) {
  return {
    candidateId,
    type: 'retire-candidate',
    targetSegmentIds: [segmentId],
    originKind: 'eval-verdict',
    evidence: { anchors: ['judgment-1'], summary: 'measured breach' },
    proposedAction: {
      mechanism: 'override-content',
      rollback: 'activate the prior version',
      sourceVersion: 1,
      contentDraft: { proposedContent: 'new content', rationale: 'measured breach' },
    },
    status: 'proposed',
    approval: { approvedBy: null, decidedAt: null, note: null },
  };
}

function fixtureContext(ownerUserId) {
  return {
    ownerUserId,
    judgmentId: 'judgment-1',
    objectiveId: 'objective-1',
    baselineEvaluationModelVersion: 'v1',
    createdAt: 100,
    baselineTraceHash: `sha256:${'a'.repeat(64)}`,
    baselineMetricId: 'metric-1',
    baseline: {
      window: { startMs: 0, endMs: 100 },
      measurement: { kind: 'count', value: 3, how_counted: 'metric-1:distinct-counterexamples(3)' },
    },
  };
}
