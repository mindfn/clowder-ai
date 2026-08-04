import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { SegmentEvaluationReadModel } = await import(
  '../dist/infrastructure/harness-eval/evaluation/SegmentEvaluationReadModel.js'
);
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
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => score >= Number(min) && score <= Number(max))
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
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

function annotation(index, polarity = 'counterexample') {
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
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity,
    confidence: 1,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

describe('F257 SegmentEvaluationReadModel', () => {
  test('S13 exposes its Objective, Evaluation Model, metrics, count progress and result window', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = new ObjectiveEvaluationRuntime(
      redis,
      {
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
          ],
        },
      },
      annotations,
    );
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
    assert.equal(count.collection.counterexamples, 3);
    assert.equal(count.collection.required, 3);
    assert.equal(count.collection.pendingTowardTrigger, 0);
    assert.deepEqual(count.latestEvaluation.result.value, { kind: 'counter', count: 3, threshold: 3 });
    assert.deepEqual(count.latestEvaluation.window, { start: 101, end: count.latestEvaluation.result.evaluatedAt });
    assert.equal(view.objectives[0].metrics[1].latestEvaluation, null);
  });
});
