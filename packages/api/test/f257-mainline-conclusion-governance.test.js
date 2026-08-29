import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// State-machine acceptance test for the F257 mainline:
// tracing -> (trigger) -> eval -> conclusion(verdict) -> governance.
// Two halves, both with REAL code:
//   1. a REAL eval rolls per-metric outcomes up into a verdict (the conclusion
//      the objective-driven redesign dropped); and
//   2. that verdict, mapped into the lifeline chain, advances deriveActiveStage
//      to governance. The regression guard pins the old bug (no conclusion ->
//      forever tracing) so it can never silently return.

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { buildVersionChain, deriveActiveStage, objectiveJudgmentToCachedJudgment } = await import(
  '../dist/routes/segment-lifeline-chain.js'
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
    const next = (this.strings.has(key) ? Number(this.strings.get(key)) : 0) + 1;
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

const counterMetric = {
  id: 'tool-schema-failure-count',
  label: 'schema failures',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'tool-schema-failure' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};
const semanticMetric = {
  id: 'tool-choice-correctness',
  label: 'tool choice correctness',
  kind: 'semantic',
  evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
  trigger: { kind: 'cadence', cadence: 'weekly' },
};

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      { id: 'em-tool', label: 'tool eval', ruleVersion: 'v1', metrics: [counterMetric, semanticMetric] },
    ],
    objectives: [
      {
        id: 'tool-access-correct-use',
        label: 'tool access',
        statement: 'use the right tool',
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

function annotation(index) {
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
    metricId: counterMetric.id,
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity: 'counterexample',
    confidence: 1,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

function episode(index) {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: 90 + index,
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
    terminal: annotation(index).episodeRef,
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
      async countUnclassified() {
        return 0;
      },
    },
    semanticEvaluator: {
      async evaluate({ retrieval }) {
        const inspected = retrieval.take(50);
        return {
          labels: { acceptable: inspected.episodes.length, counterexample: 0 },
          explanation: 'Deterministic fixture inspected the frozen Unit corpus.',
        };
      },
    },
  });
}

function objectiveJudgment(verdict, counterValue = { kind: 'counter', count: 0, threshold: 3 }) {
  return {
    judgmentId: `judgment-${verdict}`,
    snapshotId: 'snapshot-1',
    ownerUserId: 'owner-1',
    objectiveId: 'tool-access-correct-use',
    evaluationModelId: 'em-tool',
    evaluationModelVersion: 'v1',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    window: { start: 0, end: 1000 },
    metricResults: [
      {
        resultId: 'result-1',
        snapshotId: 'snapshot-1',
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        metricId: 'm1',
        kind: 'counter',
        value: counterValue,
        evaluatedAt: 900,
      },
    ],
    metricOutcomes: [{ metricId: 'm1', status: 'evaluated' }],
    annotationIds: [],
    completion: 'complete',
    verdict,
    evaluatedAt: 900,
  };
}

const observations = [{ timestamp: 500, version: 1, fired: true }];

function activeOf(chain) {
  return chain.find((epoch) => epoch.isActive) ?? chain[chain.length - 1];
}

describe('F257 mainline conclusion -> governance', () => {
  test('an `alive` conclusion maps into the lifeline chain and reaches governance', () => {
    const cached = objectiveJudgmentToCachedJudgment(objectiveJudgment('alive'), 'S13');
    assert.equal(cached.verdict, 'alive');

    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations,
      currentContentVersion: null,
      judgmentHistory: [cached],
    });
    const active = activeOf(chain);
    assert.ok(active.eval, 'eval stage must be attached from the conclusion');
    assert.equal(active.eval.verdict, 'alive');
    assert.equal(deriveActiveStage(active), 'governance');
  });

  test('REGRESSION GUARD: without a conclusion the identical chain stalls at tracing (the old bug)', () => {
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations,
      currentContentVersion: null,
      judgmentHistory: [],
    });
    const active = activeOf(chain);
    assert.equal(active.eval ?? null, null);
    assert.equal(deriveActiveStage(active), 'tracing');
  });

  test('a breach `retire-candidate` conclusion carries violation evidence into the chain', () => {
    const cached = objectiveJudgmentToCachedJudgment(
      objectiveJudgment('retire-candidate', { kind: 'counter', count: 3, threshold: 3 }),
      'S13',
    );
    assert.equal(cached.verdict, 'retire-candidate');
    assert.equal(cached.violationCount, 3);
  });

  test('REAL eval: a triggered Objective run rolls its metric outcomes up into a verdict (Gap 1 end-to-end)', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    // three distinct counterexamples trip the counter trigger -> the Objective evaluates
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment, 'a real eval run must have committed a judgment');
    assert.ok(judgment.verdict, 'the committed judgment must carry a rolled-up verdict (the dropped conclusion)');
    // measured (metrics evaluated) + a breached counter (3/3) -> retire-candidate
    assert.equal(judgment.verdict, 'retire-candidate');

    // and that REAL judgment maps cleanly into the lifeline chain (carrying its verdict)
    const cached = objectiveJudgmentToCachedJudgment(judgment, 'S13');
    assert.equal(cached.verdict, 'retire-candidate');
  });
});
