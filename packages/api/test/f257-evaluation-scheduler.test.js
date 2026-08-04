import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { EvaluationSnapshotStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.js'
);
const { MetricResultStore } = await import('../dist/infrastructure/harness-eval/evaluation/MetricResultStore.js');
const { EvaluationScheduler, evaluateCounterSnapshot } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationScheduler.js'
);
const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);

class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.sets = new Map();
    this.zsets = new Map();
  }

  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async sadd(key, ...members) {
    const set = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added++;
      set.add(member);
    }
    this.sets.set(key, set);
    return added;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async zadd(key, score, member) {
    const zset = this.zsets.get(key) ?? new Map();
    zset.set(member, Number(score));
    this.zsets.set(key, zset);
    return 1;
  }

  async zrangebyscore(key, min, max) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => score >= Number(min) && score <= Number(max))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }
}

function annotation(index, incidentKey = `incident-${index}`) {
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
      terminalAt: 100 + index,
      terminalKind: 'completed',
      toolCalls: [],
    },
    source: 'structured-rule',
    ruleId: 'tool-schema-error-v1',
    objectiveId: 'tool-access-correct-use',
    metricId: 'tool-schema-failure-count',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity: 'counterexample',
    confidence: 1,
    incidentKey,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

const metric = {
  id: 'tool-schema-failure-count',
  label: '工具名或 Schema 校验失败次数',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'counter-distinct-episodes-v1' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};

describe('F257 annotation-driven EvaluationScheduler', () => {
  test('three distinct counterexample episodes trigger one count result without a denominator', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const results = new MetricResultStore(redis);
    const scheduler = new EvaluationScheduler({ annotations, snapshots });

    await annotations.append(annotation(1));
    assert.deepEqual(
      await scheduler.schedule({
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        metric,
        ruleVersion: 'v1',
        now: 1000,
      }),
      { status: 'not-ready', observed: 1, required: 3 },
    );

    await annotations.append(annotation(2));
    // A second producer naming the same incident must not change readiness.
    await annotations.append({ ...annotation(20, 'incident-2'), annotationId: 'ann-duplicate-producer' });
    assert.deepEqual(
      await scheduler.schedule({
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        metric,
        ruleVersion: 'v1',
        now: 1000,
      }),
      { status: 'not-ready', observed: 2, required: 3 },
    );

    await annotations.append(annotation(3));
    const scheduled = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      metric,
      ruleVersion: 'v1',
      now: 1000,
    });
    assert.equal(scheduled.status, 'queued');
    assert.equal(scheduled.snapshot.annotationIds.length, 3);
    assert.equal(new Set(scheduled.snapshot.episodeRefs.map((ref) => ref.invocationId)).size, 3);

    const result = evaluateCounterSnapshot(scheduled.snapshot, metric, 1100);
    assert.deepEqual(result.value, { kind: 'counter', count: 3, threshold: 3 });
    assert.equal('denominator' in result.value, false);
    assert.equal('rate' in result.value, false);
    assert.equal((await results.append(result)).outcome, 'created');

    assert.deepEqual(
      await scheduler.schedule({
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        metric,
        ruleVersion: 'v1',
        now: 1200,
      }),
      { status: 'not-ready', observed: 0, required: 3 },
    );
  });

  test('concurrent schedulers converge on the same immutable snapshot', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const scheduler = new EvaluationScheduler({ annotations, snapshots });
    await Promise.all([1, 2, 3].map((index) => annotations.append(annotation(index))));

    const input = {
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      metric,
      ruleVersion: 'v1',
      now: 1000,
    };
    const [left, right] = await Promise.all([scheduler.schedule(input), scheduler.schedule(input)]);
    const queued = [left, right].filter((item) => item.status === 'queued');
    const empty = [left, right].filter((item) => item.status === 'not-ready');
    assert.equal(queued.length, 1);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].observed, 0);
    assert.equal((await snapshots.get(queued[0].snapshot.snapshotId)).snapshotId, queued[0].snapshot.snapshotId);
  });

  test('EvaluationIndexer validates coordinates and runtime auto-writes the threshold result', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const catalog = {
      registry: {
        registryVersion: 2,
        evaluationModels: [{ id: 'em-tool', label: 'Tool', ruleVersion: 'v1', metrics: [metric] }],
        objectives: [
          {
            id: 'tool-access-correct-use',
            label: 'Tool',
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
    const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations);

    await assert.rejects(
      runtime.append({ ...annotation(9), metricId: 'invented-metric' }),
      /invalid_evaluation_coordinate/,
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    assert.equal(
      (
        await runtime.results.queryMetricWindow(
          'owner-1',
          'tool-access-correct-use',
          'tool-schema-failure-count',
          0,
          2000,
        )
      ).length,
      0,
    );
    await runtime.append(annotation(3));
    const metricResults = await runtime.results.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      'tool-schema-failure-count',
      0,
      Date.now() + 1,
    );
    assert.equal(metricResults.length, 1);
    assert.deepEqual(metricResults[0].value, { kind: 'counter', count: 3, threshold: 3 });
  });
});
