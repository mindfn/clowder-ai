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
    const existed = this.strings.delete(key) || this.sets.delete(key) || this.zsets.delete(key);
    return existed ? 1 : 0;
  }
  async incr(key) {
    const next = Number(this.strings.get(key) ?? 0) + 1;
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
  async zcount(key, min, max) {
    return [...(this.zsets.get(key) ?? new Map()).values()].filter(
      (score) => score >= Number(min) && score <= Number(max),
    ).length;
  }
  async zrange(key, start, end, withScores) {
    const rows = this.sorted(key);
    const selected = rows.slice(start, end < 0 ? undefined : end + 1);
    return withScores === 'WITHSCORES'
      ? selected.flatMap(([member, score]) => [member, String(score)])
      : selected.map(([member]) => member);
  }
  async zrangebyscore(key, min, max) {
    const lower = Number(String(min).replace(/^\(/, ''));
    const upper = Number(String(max).replace(/^\(/, ''));
    const lowerOpen = String(min).startsWith('(');
    const upperOpen = String(max).startsWith('(');
    return this.sorted(key)
      .filter(
        ([, score]) => (lowerOpen ? score > lower : score >= lower) && (upperOpen ? score < upper : score <= upper),
      )
      .map(([member]) => member);
  }
  async zrevrange(key, start, end) {
    const rows = this.sorted(key).reverse();
    return rows.slice(start, end < 0 ? undefined : end + 1).map(([member]) => member);
  }
  sorted(key) {
    return [...(this.zsets.get(key) ?? new Map()).entries()].sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    );
  }
}

const metrics = [
  {
    id: 'failure-count',
    label: '工具调用失败',
    kind: 'counter',
    evaluator: { kind: 'code', ruleRef: 'tool-failure' },
    trigger: { kind: 'distinct-counterexamples', threshold: 3 },
    verdictRule: { kind: 'counter-zero' },
  },
  {
    id: 'choice-quality',
    label: '工具选择正确性',
    kind: 'semantic',
    evaluator: { kind: 'llm', ruleRef: 'choice-quality' },
    trigger: { kind: 'cadence', cadence: 'weekly' },
    verdictRule: { kind: 'evidence-only' },
  },
];
const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-tool-access',
        label: '工具能力评估',
        ruleVersion: 'v4',
        cycleTrigger: {
          cumulativeThreshold: 200,
          counterexampleThreshold: 3,
          cadenceDays: 7,
          minimumIntervalMs: 7_200_000,
        },
        metrics,
      },
    ],
    objectives: [
      {
        id: 'tool-access',
        label: '工具能力可达',
        statement: 'Use the right tool correctly',
        evaluationModelId: 'em-tool-access',
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
        objectives: [{ objectiveId: 'tool-access' }],
      },
    ],
  },
};

function episode(index, terminalAt) {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: terminalAt,
      segments: [
        {
          segmentId: 'S13',
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
    terminal: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      catId: 'cat-1',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt,
      terminalKind: 'completed',
      toolCalls: [],
    },
  };
}

function annotation(index, createdAt, incidentKey = `incident-${index}`) {
  return {
    annotationId: `ann-${index}`,
    episodeRef: episode(index, createdAt).terminal,
    source: 'structured-rule',
    ruleId: 'tool-failure',
    objectiveId: 'tool-access',
    metricId: 'failure-count',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity: 'counterexample',
    confidence: 1,
    incidentKey,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt,
  };
}

function currentCycle(overrides = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle-current',
    ownerUserId: 'owner-1',
    objectiveId: 'tool-access',
    version: 'S13@2',
    versionContentRef: 'hook:S13@2',
    cycleStart: 100,
    evalStatus: 'idle',
    windows: [],
    ...overrides,
  };
}

function runtimeFor(redis, episodes) {
  const annotations = new TraceAnnotationStore(redis);
  const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
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
    },
  });
  return { annotations, runtime };
}

async function seedCurrent(redis, cycle) {
  await redis.set('harness-cycle-current:owner-1:tool-access', JSON.stringify(cycle));
}

describe('F257 SegmentEvaluationReadModel', () => {
  test('projects two tracing groups and all three per-Objective trigger lanes from CycleRecord', async () => {
    const redis = new FakeRedis();
    const { annotations, runtime } = runtimeFor(redis, [episode(1, 50), episode(2, 150), episode(3, 250)]);
    await seedCurrent(redis, currentCycle());
    await annotations.append(annotation(2, 150, 'same-incident'));
    await annotations.append(annotation(3, 250, 'same-incident'));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.deepEqual(Object.keys(view.tracing).sort(), ['structuredCounterexamples', 'trigger']);
    assert.deepEqual(view.tracing.trigger.perObjective, [
      {
        objectiveId: 'tool-access',
        evalStatus: 'idle',
        cycleStartMs: 100,
        cycleEndMs: null,
        triggeredBy: [],
        cumulative: { count: 2, threshold: 200 },
        counterexamples: { count: 1, threshold: 3 },
        cadence: { elapsedMs: 200, thresholdMs: 604_800_000, eligible: true },
      },
    ]);
    assert.equal(view.tracing.structuredCounterexamples.length, 1);
    assert.equal('unclassifiedEpisodeCount' in view.tracing, false);
  });

  test('uses frozen cycleEnd and surfaces metric catalog, latest verdict, governance, and version chain', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, [episode(1, 150), episode(2, 250)]);
    const evaluated = currentCycle({
      cycleEnd: 200,
      evalStatus: 'written',
      windows: [{ start: 100, end: 200 }],
      triggeredBy: ['cumulative'],
      evaluation: {
        overall: 'complete',
        writtenAt: 220,
        by: 'cat-eval',
        metrics: [
          {
            id: 'failure-count',
            conclusion: { kind: 'count', value: 1, howCounted: 'one incident' },
            evidenceRefs: ['invocation://inv-1'],
          },
        ],
      },
      governance: { decision: 'evolve', reason: 'tighten wording', writtenAt: 230, by: 'cat-eval' },
      approval: { cardId: 'HGP-1', state: 'pending', rejectCount: 0, at: 231 },
    });
    await seedCurrent(redis, evaluated);
    const prior = { ...currentCycle(), cycleId: 'cycle-prior', version: 'S13@1', closedAt: 90 };
    await redis.set('harness-cycle-history:owner-1:tool-access:cycle-prior', JSON.stringify(prior));
    await redis.zadd('harness-cycle-history-index:owner-1:tool-access', 90, 'cycle-prior');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });
    const objective = view.objectives[0];

    assert.equal(view.tracing.trigger.perObjective[0].cumulative.count, 1, 'trace after frozen cycleEnd is excluded');
    assert.equal(objective.objectiveStatement, 'Use the right tool correctly');
    assert.equal(objective.metrics.length, 2, 'metric catalog is always visible');
    assert.equal(objective.metrics[0].latestConclusion.value, 1);
    assert.deepEqual(objective.metrics[0].evidenceRefs, ['invocation://inv-1']);
    assert.equal(objective.latestEvaluation.overall, 'complete');
    assert.equal(objective.latestGovernance.decision, 'evolve');
    assert.equal(objective.latestGovernance.by, 'cat-eval');
    assert.equal(objective.latestGovernance.approval.cardId, 'HGP-1');
    assert.deepEqual(
      objective.versionChain.map((cycle) => cycle.version),
      ['S13@1', 'S13@2'],
    );
  });

  test('resolves explicit version windows and rejects partial coordinates', () => {
    assert.deepEqual(resolveEvaluationWindow({ startMs: '100', endMs: '200' }, 999), { startMs: 100, endMs: 200 });
    assert.equal(resolveEvaluationWindow({ startMs: '100' }, 999), null);
    assert.equal(resolveEvaluationWindow({ startMs: '200', endMs: '100' }, 999), null);
  });
});
