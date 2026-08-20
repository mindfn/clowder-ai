/**
 * F257 P1-1/P1-2/P1-3 — Real-Redis regression drills for Unit evaluation atomic
 * boundaries.
 *
 * These tests require an isolated local Redis (db 15 or manifest-assigned).
 * Run via: REDIS_URL=redis://127.0.0.1:6398/15 CAT_CAFE_REDIS_TEST_ISOLATED=1 \
 *   node --test packages/api/test/f257-unit-evaluation-atomic-boundaries-redis.test.js
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F257 Unit evaluation atomic boundaries - real Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let createRedisClient;
  let redis;
  let TraceAnnotationStore;
  let ObjectiveEvaluationRuntime;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'f257-unit-evaluation-atomic-boundaries-redis');

    const shared = await import('@cat-cafe/shared/utils');
    createRedisClient = shared.createRedisClient;

    const storeMod = await import('../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js');
    TraceAnnotationStore = storeMod.TraceAnnotationStore;

    const runtimeMod = await import('../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js');
    ObjectiveEvaluationRuntime = runtimeMod.ObjectiveEvaluationRuntime;

    redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'f257-unit-boundaries:' });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[f257-unit-evaluation-atomic-boundaries-redis] Redis unreachable, skipping drills');
      await redis.quit().catch(() => {});
    }
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

  const countMetric = {
    id: 'tool-schema-failure-count',
    label: 'Count',
    kind: 'counter',
    evaluator: { kind: 'code', ruleRef: 'counter-distinct-episodes-v1' },
    trigger: { kind: 'distinct-counterexamples', threshold: 1 },
  };

  const catalog = {
    registry: {
      registryVersion: 2,
      evaluationModels: [
        {
          id: 'em-tool',
          label: 'Tool',
          ruleVersion: 'v1',
          metrics: [countMetric],
        },
      ],
      objectives: [
        {
          id: 'tool-access-correct-use',
          label: 'Tool access',
          statement: 'Use tools correctly',
          evaluationModelId: 'em-tool',
        },
      ],
    },
    manifest: {
      manifestVersion: 1,
      registryVersion: 2,
      units: [
        {
          unitId: 'S13',
          hookId: 's13-doc',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'tool-access-correct-use' }],
        },
      ],
    },
  };

  function annotation(index, createdAt) {
    return {
      annotationId: `ann-${index}`,
      episodeRef: {
        traceTurnId: `turn-${index}`,
        invocationId: `inv-${index}`,
        ownerUserId: 'owner-1',
        threadId: 'thread-1',
        catId: 'cat-1',
        inputMessageId: `input-${index}`,
        outputMessageId: `output-${index}`,
        terminalAt: createdAt,
        terminalKind: 'completed',
        toolCalls: [],
      },
      source: 'structured-rule',
      ruleId: 'tool-schema-error-v1',
      objectiveId: 'tool-access-correct-use',
      metricId: countMetric.id,
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      polarity: 'counterexample',
      confidence: 1,
      incidentKey: `incident-${index}`,
      evidenceRefs: [`invocation://inv-${index}`],
      createdAt,
    };
  }

  function makeRuntime() {
    const annotations = new TraceAnnotationStore(redis);
    return new ObjectiveEvaluationRuntime(redis, catalog, annotations);
  }

  it('P1-1 mid-script type error aborts before any durable write', async () => {
    const runtime = makeRuntime();

    // Pre-set the count metric result index to a string. The atomic commit Lua
    // preflights key types and must return -1 before any mutating command, so
    // no result payload, judgment, or consumed annotation is written.
    const resultIndexKey = `harness-metric-result-index:owner-1:tool-access-correct-use:${countMetric.id}`;
    await redis.set(resultIndexKey, 'sabotage');

    await runtime.append(annotation(1, 100));

    assert.equal(await runtime.judgments.latest('owner-1', 'tool-access-correct-use'), null);

    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use');
    assert.equal(consumed.has('ann-1'), false, 'annotation must remain unconsumed after aborted commit');

    const pending = await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.ok(pending, 'pending UnitRun must survive a retryable preflight failure');

    // Repair the key type and retry. The scheduler resumes the same immutable
    // snapshot and the commit succeeds.
    await redis.del(resultIndexKey);
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 1000);

    const retryResults = await runtime.results.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      countMetric.id,
      0,
      2000,
    );
    assert.equal(retryResults.length, 1, 'retry must produce the result');
    const retryJudgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(retryJudgment, 'retry must produce the judgment');
    assert.ok((await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use')).has('ann-1'));
  });

  it('P1-2 later-now retry resumes the same frozen snapshot', async () => {
    const runtime = makeRuntime();

    // Inject a transient failure on the first Lua commit only. The commit script
    // has 4 fixed keys plus 2 keys per result plus 2 judgment keys, so a key
    // count >= 6 identifies the commit command.
    const originalEval = redis.eval.bind(redis);
    let commitAttempts = 0;
    redis.eval = async (script, ...args) => {
      const numKeys = args[0];
      if (typeof numKeys === 'number' && numKeys >= 6) {
        commitAttempts++;
        if (commitAttempts === 1) {
          throw new Error('injected_commit_failure');
        }
      }
      return originalEval(script, ...args);
    };

    await runtime.append(annotation(1, 100));

    assert.equal(
      (await runtime.results.queryMetricWindow('owner-1', 'tool-access-correct-use', countMetric.id, 0, 2000)).length,
      0,
    );
    assert.equal(await runtime.judgments.latest('owner-1', 'tool-access-correct-use'), null);

    const pending = await runtime.snapshots.getPendingUnitRun('owner-1', 'tool-access-correct-use');
    assert.ok(pending, 'pending UnitRun must hold the frozen snapshot');
    const firstSnapshotId = pending.snapshot.snapshotId;

    // Retry at a later `now`. The scheduler resumes the pending immutable
    // snapshot, so the committed judgment keeps the same snapshotId.
    redis.eval = originalEval;
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 1001);

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment, 'retry at a later now must commit');
    assert.equal(judgment.snapshotId, firstSnapshotId);
    assert.ok((await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use')).has('ann-1'));
  });

  it('P1-3 same-ms late-arrival annotation is consumed by the next run', async () => {
    const runtime = makeRuntime();
    const annotations = runtime.annotations;

    // First annotation at t=100 triggers and commits a Unit run.
    await runtime.append(annotation(1, 100));
    const judgment1 = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment1);
    assert.deepEqual(judgment1.annotationIds, ['ann-1']);

    // Second annotation shares the same createdAt but arrives after the first
    // run has already advanced the composite watermark. It must still be
    // visible to the next Unit run because the watermark is a composite cursor
    // (timestamp + sequence), not a simple exclusive timestamp.
    await annotations.append(annotation(2, 100));
    await runtime.scheduleObjective('owner-1', 'tool-access-correct-use', 200);

    const windowed = await runtime.judgments.queryWindow('owner-1', 'tool-access-correct-use', 0, 201);
    assert.equal(windowed.length, 2, 'two Unit runs must have committed');
    const judgment2 = windowed.find((j) => j.judgmentId !== judgment1.judgmentId);
    assert.ok(judgment2);
    assert.deepEqual(judgment2.annotationIds, ['ann-2']);

    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'tool-access-correct-use');
    assert.ok(consumed.has('ann-1'));
    assert.ok(consumed.has('ann-2'));
  });
});
