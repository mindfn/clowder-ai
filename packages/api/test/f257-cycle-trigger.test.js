import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { CycleTriggerChecker } = await import('../dist/infrastructure/harness-eval/evaluation/CycleTriggerChecker.js');

class FakeRedis {
  strings = new Map();
  sets = new Map();
  zsets = new Map();

  async get(key) {
    return this.strings.get(key) ?? null;
  }

  async set(key, value, mode) {
    if (mode === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }

  async sadd(key, ...members) {
    const set = this.sets.get(key) ?? new Set();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }

  async zadd(key, score, member) {
    const entries = this.zsets.get(key) ?? new Map();
    entries.set(member, Number(score));
    this.zsets.set(key, entries);
    return 1;
  }

  async zrevrange(key, start, end) {
    const ordered = [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
      .map(([member]) => member);
    return ordered.slice(start, end < 0 ? undefined : end + 1);
  }

  async eval(_script, _keyCount, key, expectedCycleId, replacement) {
    const current = JSON.parse(this.strings.get(key) ?? 'null');
    if (current?.cycleId !== expectedCycleId || current.evalStatus !== 'idle') return 0;
    this.strings.set(key, replacement);
    return 1;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const model = (overrides = {}) => ({
  id: 'em-obj',
  label: 'Objective model',
  ruleVersion: 'v1',
  cycleTrigger: {
    cumulativeThreshold: 3,
    counterexampleThreshold: 2,
    cadenceDays: 7,
    minimumIntervalMs: 2 * 60 * 60 * 1000,
    ...overrides,
  },
  metrics: [
    {
      id: 'metric-a',
      label: 'Metric A',
      kind: 'counter',
      evaluator: { kind: 'code', ruleRef: 'metric-a' },
      trigger: { kind: 'distinct-counterexamples', threshold: 2 },
      verdictRule: { kind: 'counter-zero' },
    },
  ],
});

function catalog(cycleModel = model()) {
  return {
    registry: {
      registryVersion: 2,
      evaluationModels: [cycleModel],
      objectives: [{ id: 'obj', label: 'Objective', statement: 'Do the thing', evaluationModelId: cycleModel.id }],
    },
    manifest: {
      manifestVersion: 1,
      registryVersion: 2,
      units: [
        {
          unitId: 'D1',
          hookId: 'd1-test',
          unitState: 'evaluable',
          objectives: [{ objectiveId: 'obj' }],
        },
      ],
    },
  };
}

function episode(id, terminalAt, status = 'observed') {
  return {
    terminal: { invocationId: id, terminalAt, ownerUserId: 'owner-1' },
    summary: { segments: [{ segmentId: 'D1', status }] },
  };
}

function createHarness({ episodes = [], annotations = [], cycleModel = model(), version = 'v4' } = {}) {
  const redis = new FakeRedis();
  const store = new CycleRecordStore(redis);
  const checker = new CycleTriggerChecker({
    catalog: catalog(cycleModel),
    cycles: store,
    traces: {
      async getEpisodeByInvocationId(invocationId) {
        return episodes.find((item) => item.terminal.invocationId === invocationId) ?? null;
      },
      async queryUnitWindow(_owner, _refs, start, end) {
        return episodes.filter((item) => item.terminal.terminalAt >= start && item.terminal.terminalAt < end);
      },
    },
    annotations: {
      async queryMetricWindow(_owner, _objective, _metric, start, end) {
        return annotations.filter((item) => item.createdAt >= start && item.createdAt < end);
      },
    },
    resolveVersion: () => ({ version, versionContentRef: `hooks:d1-test@${version}` }),
  });
  return { redis, store, checker };
}

function seedHistory(redis, record) {
  redis.strings.set(
    `harness-cycle-history:${record.ownerUserId}:${record.objectiveId}:${record.cycleId}`,
    JSON.stringify(record),
  );
  const index = `harness-cycle-history-index:${record.ownerUserId}:${record.objectiveId}`;
  const entries = redis.zsets.get(index) ?? new Map();
  entries.set(record.cycleId, record.closedAt);
  redis.zsets.set(index, entries);
}

describe('F257 CycleRecord trigger checker', () => {
  test('initializes the first cycle from now when no valid trace exists', async () => {
    const { checker, store } = createHarness();
    const result = await checker.checkObjective('owner-1', 'obj', 5_000);
    const current = await store.current('owner-1', 'obj');

    assert.equal(result.status, 'idle');
    assert.equal(current.cycleStart, 5_000);
    assert.equal(current.evalStatus, 'idle');
  });

  test('prefers the preserved completed-window end and rejects a future start', async () => {
    const preserved = createHarness({ episodes: [episode('a', 100)], cycleModel: model({ cumulativeThreshold: 99 }) });
    preserved.redis.strings.set('harness-unit-run-completed-window-end:owner-1:obj', '900');
    await preserved.checker.checkObjective('owner-1', 'obj', 1_000);
    assert.equal((await preserved.store.current('owner-1', 'obj')).cycleStart, 900);

    const invalid = createHarness();
    invalid.redis.strings.set('harness-unit-run-completed-window-end:owner-1:obj', '1001');
    await assert.rejects(invalid.checker.checkObjective('owner-1', 'obj', 1_000), /cycle_start_after_now:obj/);
  });

  test('any cumulative threshold requests one small window-only record under concurrency', async () => {
    const { checker, store } = createHarness({
      episodes: [episode('a', 1_000), episode('b', 1_100), episode('c', 1_200)],
    });
    await Promise.all([checker.checkTrace('owner-1', 'c', 2_000), checker.checkObjective('owner-1', 'obj', 2_000)]);
    const current = await store.current('owner-1', 'obj');
    const serialized = JSON.stringify(current);

    assert.equal(current.evalStatus, 'requested');
    assert.deepEqual(current.triggeredBy, ['cumulative']);
    assert.deepEqual(current.windows, [{ start: 1_000, end: 2_000 }]);
    assert.equal(current.version, 'v4');
    assert.ok(Buffer.byteLength(serialized) < 1_024, serialized);
    assert.doesNotMatch(serialized, /traceCorpus|invocationId|summary/);
  });

  test('deduplicated counterexamples and cadence are independent trigger routes', async () => {
    const counterexamples = [
      { createdAt: 1_100, polarity: 'counterexample', incidentKey: 'same' },
      { createdAt: 1_200, polarity: 'counterexample', incidentKey: 'same' },
      { createdAt: 1_300, polarity: 'counterexample', incidentKey: 'other' },
    ];
    const counter = createHarness({ episodes: [episode('a', 1_000)], annotations: counterexamples });
    const counterResult = await counter.checker.checkObjective('owner-1', 'obj', 2_000);
    assert.equal(counterResult.status, 'requested');
    assert.deepEqual((await counter.store.current('owner-1', 'obj')).triggeredBy, ['counterexamples']);

    const cadence = createHarness({ episodes: [episode('a', 1_000)], cycleModel: model({ cumulativeThreshold: 99 }) });
    await cadence.checker.checkObjective('owner-1', 'obj', 1_001);
    const cadenceResult = await cadence.checker.checkObjective('owner-1', 'obj', 1_000 + 7 * DAY);
    assert.equal(cadenceResult.status, 'requested');
    assert.deepEqual((await cadence.store.current('owner-1', 'obj')).triggeredBy, ['cadence']);
  });

  test('minimum interval blocks an immediate trigger and consecutive skips expand windows once', async () => {
    const { redis, checker, store } = createHarness({
      episodes: [episode('a', 201), episode('b', 202), episode('c', 203)],
    });
    seedHistory(redis, {
      schemaVersion: 1,
      cycleId: 'cycle-1',
      ownerUserId: 'owner-1',
      objectiveId: 'obj',
      version: 'v1',
      versionContentRef: 'hooks:d1-test@v1',
      cycleStart: 0,
      cycleEnd: 100,
      evalStatus: 'written',
      windows: [{ start: 0, end: 100 }],
      approval: { state: 'skipped', rejectCount: 0, at: 110 },
      closedAt: 110,
    });
    seedHistory(redis, {
      schemaVersion: 1,
      cycleId: 'cycle-2',
      ownerUserId: 'owner-1',
      objectiveId: 'obj',
      version: 'v2',
      versionContentRef: 'hooks:d1-test@v2',
      cycleStart: 100,
      cycleEnd: 200,
      evalStatus: 'written',
      windows: [
        { start: 0, end: 100 },
        { start: 100, end: 200 },
      ],
      approval: { state: 'skipped', rejectCount: 0, at: 210 },
      closedAt: 210,
    });
    await store.initialize('owner-1', 'obj', 200, { version: 'v4', versionContentRef: 'hooks:d1-test@v4' });

    const blocked = await checker.checkObjective('owner-1', 'obj', 210 + 2 * 60 * 60 * 1000 - 1);
    assert.equal(blocked.status, 'interval');

    const requested = await checker.checkObjective('owner-1', 'obj', 210 + 2 * 60 * 60 * 1000);
    assert.equal(requested.status, 'requested');
    assert.deepEqual((await store.current('owner-1', 'obj')).windows, [
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 7_200_210 },
    ]);
  });
});
