import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { SegmentEvaluationReadModel } = await import(
  '../dist/infrastructure/harness-eval/evaluation/SegmentEvaluationReadModel.js'
);
const { resolveEvaluationWindow } = await import('../dist/routes/segment-evaluation.js');
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
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
  async del(key) {
    const had = this.strings.has(key) || this.sets.has(key) || this.zsets.has(key);
    this.strings.delete(key);
    this.sets.delete(key);
    this.zsets.delete(key);
    return had ? 1 : 0;
  }
  async incr(key) {
    const current = this.strings.has(key) ? Number(this.strings.get(key)) : 0;
    const next = current + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async type(key) {
    if (this.strings.has(key)) return 'string';
    if (this.sets.has(key)) return 'set';
    if (this.zsets.has(key)) return 'zset';
    return 'none';
  }
  async sadd(key, ...members) {
    const values = this.sets.get(key) ?? new Set();
    for (const member of members) values.add(member);
    this.sets.set(key, values);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async zadd(key, score, member) {
    const values = this.zsets.get(key) ?? new Map();
    values.set(member, Number(score));
    this.zsets.set(key, values);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const minExclusive = String(min).startsWith('(');
    const maxExclusive = String(max).startsWith('(');
    const minScore = Number(String(min).replace(/^\(/, ''));
    const maxScore = Number(String(max).replace(/^\(/, ''));
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => {
        if (minExclusive ? score <= minScore : score < minScore) return false;
        if (maxExclusive ? score >= maxScore : score > maxScore) return false;
        return true;
      })
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }
  async zrevrange(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .slice(start, end + 1)
      .map(([member]) => member);
  }
}

const countMetric = {
  id: 'tool-schema-failure-count',
  label: '工具名或 Schema 校验失败次数',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'tool-schema-failure' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};
const semanticMetric = {
  id: 'tool-choice-correctness',
  label: '语义场景下工具选择与参数正确性',
  kind: 'semantic',
  evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
  trigger: { kind: 'cadence', cadence: 'weekly' },
};

function annotation(index, polarity = 'counterexample', unitId = 'S13') {
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
    ruleId: 'tool-schema-failure',
    objectiveId: 'tool-access-correct-use',
    metricId: countMetric.id,
    unitRefs: [{ unitType: 'segment', unitId }],
    polarity,
    confidence: 1,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

function episode(index, unitId = 'S13') {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: 90 + index,
      segments: [
        {
          segmentId: unitId,
          stage: 'per-turn',
          status: 'observed',
          contentHash: `hash-${index}`,
          charCount: 10,
          tokenEstimate: 3,
          pipelineStatus: 'fired',
        },
      ],
      delivery: [],
      totalCharCount: 10,
      totalTokenEstimate: 3,
      totalSegmentsObserved: 1,
      totalSegmentsAbsent: 0,
      durationMs: 1,
    },
    terminal: annotation(index, 'counterexample', unitId).episodeRef,
  };
}

function runtimeFor(redis, annotations, episodes) {
  return new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
    traceStore: {
      async queryUnitWindow(ownerUserId, unitRefs, startMs, endMs) {
        return episodes.filter(
          (item) =>
            item.terminal.ownerUserId === ownerUserId &&
            item.terminal.terminalAt >= startMs &&
            item.terminal.terminalAt < endMs &&
            item.summary.segments.some((segment) =>
              unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === segment.segmentId),
            ),
        );
      },
      async countSegmentWindow(ownerUserId, segmentId, startMs, endMs) {
        return episodes.filter(
          (item) =>
            item.terminal.ownerUserId === ownerUserId &&
            item.terminal.terminalAt >= startMs &&
            item.terminal.terminalAt < endMs &&
            item.summary.segments.some((segment) => segment.segmentId === segmentId && segment.status === 'observed'),
        ).length;
      },
    },
    semanticEvaluator: {
      async evaluate({ retrieval }) {
        const inspected = retrieval.take(50);
        return {
          labels: { acceptable: inspected.episodes.length, counterexample: 0 },
          explanation: 'Deterministic read-model fixture inspected the frozen Unit corpus.',
        };
      },
    },
  });
}

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-tool-access-correct-use',
        label: '工具可达与正确使用评估',
        ruleVersion: 'v1',
        metrics: [countMetric, semanticMetric],
      },
    ],
    objectives: [
      {
        id: 'tool-access-correct-use',
        label: '工具能力可达与正确使用',
        statement: 'Use the right tool correctly',
        evaluationModelId: 'em-tool-access-correct-use',
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
      {
        unitId: 'D11',
        hookId: 'd11-skill-trigger',
        unitState: 'evaluable',
        objectives: [{ objectiveId: 'tool-access-correct-use' }],
      },
    ],
  },
};

describe('F257 SegmentEvaluationReadModel', () => {
  test('S13 exposes its Objective, Evaluation Model, metrics, count progress and result window', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: Date.now() + 1,
    });
    assert.equal(view.objectives.length, 1);
    assert.deepEqual(view.objectives[0].unitRefs, [
      { unitType: 'segment', unitId: 'S13' },
      { unitType: 'segment', unitId: 'D11' },
    ]);
    assert.deepEqual(
      {
        objectiveId: view.objectives[0].objectiveId,
        evaluationModelId: view.objectives[0].evaluationModelId,
        metricIds: view.objectives[0].metrics.map((metric) => metric.metricId),
      },
      {
        objectiveId: 'tool-access-correct-use',
        evaluationModelId: 'em-tool-access-correct-use',
        metricIds: ['tool-schema-failure-count', 'tool-choice-correctness'],
      },
    );
    const count = view.objectives[0].metrics[0];
    // Annotations were consumed by the Unit run; collection shows remaining pending
    // candidates only, while the committed result carries the historical count.
    assert.equal(count.collection.counterexamples, 0);
    assert.equal(count.collection.required, 3);
    assert.equal(count.collection.pendingTowardTrigger, 0);
    assert.deepEqual(count.latestEvaluation.result.value, { kind: 'counter', count: 3, threshold: 3 });
    assert.deepEqual(count.latestEvaluation.window, { start: 0, end: count.latestEvaluation.result.evaluatedAt });
    assert.equal(view.objectives[0].metrics[1].latestEvaluation.result.value.kind, 'semantic');
  });

  test('shares one Objective Unit result across all member segments while keeping annotation progress local', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3), episode(4, 'D11')]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    await runtime.append(annotation(4, 'counterexample', 'D11'));

    const d11 = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'D11',
      startMs: 0,
      endMs: Date.now() + 1,
    });
    const metric = d11.objectives[0].metrics[0];
    // D11 has one local pending counterexample. The completed judgment is still
    // visible because S13 and D11 are members of one Objective Unit.
    assert.equal(metric.collection.counterexamples, 1);
    assert.equal(metric.collection.pendingTowardTrigger, 1);
    assert.deepEqual(metric.latestEvaluation.result.value, { kind: 'counter', count: 3, threshold: 3 });
  });

  test('exposes Unit tracing readiness and structured counterexamples without metric buckets', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2)]);
    await annotations.append(annotation(1));
    await annotations.append(annotation(2));

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });

    assert.deepEqual(view.tracing.trigger, {
      traceCount: 2,
      traceRequired: 200,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      counterexampleCount: 2,
      counterexampleRequired: 3,
    });
    assert.equal(view.tracing.structuredCounterexamples.length, 2);
    assert.deepEqual(
      view.tracing.structuredCounterexamples.map(({ incidentKey, metricId }) => ({ incidentKey, metricId })),
      [
        { incidentKey: 'incident-1', metricId: countMetric.id },
        { incidentKey: 'incident-2', metricId: countMetric.id },
      ],
    );
    assert.equal(view.objectives[0].metrics[0].evaluatorRuleRef, 'tool-schema-failure');
  });

  test('resolves explicit version windows and rejects partial coordinates', () => {
    assert.deepEqual(resolveEvaluationWindow({ startMs: '100', endMs: '200' }, 999), { startMs: 100, endMs: 200 });
    assert.equal(resolveEvaluationWindow({ startMs: '100' }, 999), null);
    assert.equal(resolveEvaluationWindow({ startMs: '200', endMs: '100' }, 999), null);
  });
});
