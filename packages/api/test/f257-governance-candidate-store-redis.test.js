/** F257 Candidate/PatchTrial production CAS contracts against isolated Redis. */

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

  test('concurrent approval converges to one durable PatchTrial and atomic completion', async () => {
    const candidate = fixtureCandidate('EC-redis-approve', 'S13');
    await store.create(candidate, fixtureContext('owner-1'));

    const input = {
      candidateId: candidate.candidateId,
      approvedBy: 'owner-1',
      note: 'operator approved',
      hookId: 'S13',
      approvedAt: 1_000,
    };
    const outcomes = await Promise.all([store.approveAndOpenPatchTrial(input), store.approveAndOpenPatchTrial(input)]);
    assert.equal(outcomes.length, 2);
    assert.equal((await store.listPatchTrials(candidate.candidateId)).length, 1);

    const approved = await store.get(candidate.candidateId);
    const [trial] = await store.listPatchTrials(candidate.candidateId);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approval.approvedBy, 'owner-1');
    assert.equal(trial.trace.beforeHash, `sha256:${'a'.repeat(64)}`);

    await store.completePatchTrial({
      currentCandidate: approved,
      nextCandidate: { ...approved, status: 'closed' },
      currentTrial: trial,
      nextTrial: {
        ...trial,
        treatment: {
          window: { startMs: 1_000, endMs: 1_000 + 7 * 24 * 60 * 60 * 1000 },
          measurement: { kind: 'count', value: 0, how_counted: 'metric-1:distinct-counterexamples(0)' },
        },
        outcome: 'improved',
        decision: 'solidify',
        trace: { ...trial.trace, afterHash: `sha256:${'b'.repeat(64)}` },
      },
    });
    assert.equal((await store.get(candidate.candidateId)).status, 'closed');
    assert.equal((await store.listPatchTrials(candidate.candidateId))[0].decision, 'solidify');
  });

  test('a stale verifying transition cannot reopen a terminal Candidate', async () => {
    const candidate = fixtureCandidate('EC-stale-verifying', 'S13');
    await store.create(candidate, fixtureContext('owner-1'));
    const { candidate: approved, trial } = await store.approveAndOpenPatchTrial({
      candidateId: candidate.candidateId,
      approvedBy: 'owner-1',
      note: 'operator approved',
      hookId: 'S13',
      approvedAt: 1_000,
    });
    await store.completePatchTrial({
      currentCandidate: approved,
      nextCandidate: { ...approved, status: 'closed' },
      currentTrial: trial,
      nextTrial: {
        ...trial,
        treatment: {
          window: { startMs: 1_000, endMs: 1_000 + 7 * 24 * 60 * 60 * 1000 },
          measurement: { kind: 'count', value: 0, how_counted: 'metric-1:distinct-counterexamples(0)' },
        },
        outcome: 'improved',
        decision: 'solidify',
        trace: { ...trial.trace, afterHash: `sha256:${'b'.repeat(64)}` },
      },
    });

    assert.equal(
      await store.updateCandidate(approved, { ...approved, status: 'verifying' }),
      false,
      'CAS miss is a no-op when another objective already terminalized the Candidate',
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
    assert.equal((await store.listPatchTrials(first.candidateId)).length, 0);
    assert.equal(await store.countPending('owner:a', 'b'), 0);
    assert.equal(await store.countPending('owner', 'a:b'), 1);
  });

  test('corrupt Candidate and PatchTrial rows fail closed instead of breaking Hub reads', async () => {
    await redis.hset('harness-governance-candidate', 'EC-corrupt', JSON.stringify({ status: 'proposed' }));
    await redis.sadd('harness-governance-candidate-owner:owner-1', 'EC-corrupt');
    assert.equal(await store.get('EC-corrupt'), null);
    assert.deepEqual(await store.listByOwner('owner-1'), []);

    await redis.hset('harness-governance-patch-trial', 'pt-EC-corrupt-1', JSON.stringify({ decision: 'pending' }));
    await redis.sadd('harness-governance-patch-trial-candidate:EC-corrupt', 'pt-EC-corrupt-1');
    assert.deepEqual(await store.listPatchTrials('EC-corrupt'), []);
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
    proposedAction: { mechanism: 'override-disable', rollback: 'clear override' },
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
