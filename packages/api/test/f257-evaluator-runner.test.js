import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { EvaluationScheduler } = await import('../dist/infrastructure/harness-eval/evaluation/EvaluationScheduler.js');
const { EvaluationSnapshotStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.js'
);
const { EvaluatorRunner } = await import('../dist/infrastructure/harness-eval/evaluation/evaluator-runner.js');
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
    const set = this.sets.get(key) ?? new Set();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
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
  async zrevrange(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .slice(start, end + 1)
      .map(([member]) => member);
  }
}

function annotation(index, polarity) {
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
      terminalAt: index,
      terminalKind: 'completed',
      toolCalls: [],
    },
    source: 'semantic-sweep',
    ruleId: 'tool-choice-correctness-semantic',
    objectiveId: 'tool-access-correct-use',
    metricId: 'tool-choice-correctness',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity,
    confidence: 0.9,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    rationale: polarity === 'positive' ? 'Correct tool and arguments.' : 'Guessed a nonexistent tool.',
    createdAt: index,
  };
}

const semanticMetric = {
  id: 'tool-choice-correctness',
  label: '语义场景下工具选择与参数正确性',
  kind: 'semantic',
  evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
  trigger: { kind: 'cadence', cadence: 'weekly' },
};

const replayMetric = {
  id: 'known-anchor-recall-rate',
  label: '已知标准答案的记忆锚点召回率',
  kind: 'replay',
  evaluator: { kind: 'replay', ruleRef: 'known-anchor-recall-suite' },
  trigger: { kind: 'cadence', cadence: 'weekly' },
};

describe('F257 evaluator runner', () => {
  test('weekly semantic result aggregates frozen LLM episode judgments and is not immediately due again', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const scheduler = new EvaluationScheduler({ annotations, snapshots });
    const runner = new EvaluatorRunner();
    await annotations.append(annotation(100, 'positive'));
    await annotations.append(annotation(101, 'counterexample'));

    const scheduled = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      metric: semanticMetric,
      ruleVersion: 'v1',
      now: 1_000,
    });
    assert.equal(scheduled.status, 'queued');
    const result = await runner.run(scheduled.snapshot, semanticMetric, 1_100);
    assert.deepEqual(result.value, {
      kind: 'semantic',
      labels: { positive: 1, counterexample: 1 },
      explanation: '2 LLM-classified episodes evaluated by tool-choice-correctness-semantic.',
    });
    await snapshots.markAnnotationsConsumed(scheduled.snapshot);
    await snapshots.markCompleted(scheduled.snapshot);
    assert.deepEqual(
      await scheduler.schedule({
        ownerUserId: 'owner-1',
        objectiveId: 'tool-access-correct-use',
        metric: semanticMetric,
        ruleVersion: 'v1',
        now: 2_000,
      }),
      { status: 'not-due', nextDueAt: 1_000 + 7 * 24 * 60 * 60 * 1000 },
    );
  });

  test('replay adapter receives an immutable cadence snapshot; absent adapter is not runnable', async () => {
    const redis = new FakeRedis();
    const scheduler = new EvaluationScheduler({
      annotations: new TraceAnnotationStore(redis),
      snapshots: new EvaluationSnapshotStore(redis),
    });
    const withoutReplay = new EvaluatorRunner();
    assert.equal(withoutReplay.canRun(replayMetric), false);

    const retryable = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'continuation-memory-recovery',
      metric: replayMetric,
      ruleVersion: 'v1',
      now: 1_000,
    });
    assert.equal(retryable.status, 'queued');
    await assert.rejects(withoutReplay.run(retryable.snapshot, replayMetric, 1_050), /replay_evaluator_unavailable/);
    const retried = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'continuation-memory-recovery',
      metric: replayMetric,
      ruleVersion: 'v1',
      now: 1_000,
    });
    assert.equal(retried.status, 'queued');
    assert.equal(retried.snapshot.snapshotId, retryable.snapshot.snapshotId);

    let seenSnapshot;
    const runner = new EvaluatorRunner({
      replay: {
        async evaluate(snapshot, metric) {
          seenSnapshot = snapshot;
          assert.equal(metric.evaluator.ruleRef, 'known-anchor-recall-suite');
          return { passed: 8, failed: 2 };
        },
      },
    });
    const scheduled = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'continuation-memory-recovery',
      metric: replayMetric,
      ruleVersion: 'v1',
      now: 1_000,
    });
    assert.equal(scheduled.status, 'queued');
    const result = await runner.run(scheduled.snapshot, replayMetric, 1_100);
    assert.equal(seenSnapshot.snapshotId, scheduled.snapshot.snapshotId);
    assert.deepEqual(result.value, { kind: 'replay', passed: 8, failed: 2 });
  });
});
