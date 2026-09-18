// F257 stalled-cycle test fixture: an in-memory Redis that understands the
// cycle CAS script, a thread store, and a one-Objective catalog. Shared by
// f257-stalled-cycle-writeback.test.js and f257-stalled-cycle-version-switch.test.js.

import assert from 'node:assert/strict';

export class FakeRedis {
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
  async zrevrange(key) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([member]) => member);
  }
  async zcard(key) {
    return (this.zsets.get(key) ?? new Map()).size;
  }
  async eval(_script, _n, currentKey, historyKey, indexKey, cycleId, status, replacement, mode, closedAt, next) {
    const current = JSON.parse(this.strings.get(currentKey) ?? 'null');
    if (current?.cycleId !== cycleId || current.evalStatus !== status) return 0;
    if (mode === 'advance') {
      this.strings.set(historyKey, replacement);
      await this.zadd(indexKey, closedAt, cycleId);
      this.strings.set(currentKey, next);
    } else {
      this.strings.set(currentKey, replacement);
    }
    return 1;
  }
}

export class FakeThreadStore {
  threads = new Map();
  async get(id) {
    return this.threads.get(id) ?? null;
  }
  async ensureThread(id, title) {
    if (!this.threads.has(id)) this.threads.set(id, { id, title, participants: [], preferredCats: [] });
    return this.threads.get(id);
  }
  async updateSystemKind(id, systemKind) {
    this.threads.get(id).systemKind = systemKind;
  }
  async indexForUser() {}
  async updateTitle(id, title) {
    this.threads.get(id).title = title;
  }
  async restore(id) {
    delete this.threads.get(id).deletedAt;
  }
  async updatePreferredCats(id, cats) {
    this.threads.get(id).preferredCats = cats;
  }
  async addParticipants(id, cats) {
    const thread = this.threads.get(id);
    thread.participants = [...new Set([...thread.participants, ...cats])];
  }
}

export const model = {
  id: 'model-1',
  label: 'Model',
  ruleVersion: 'v1',
  cycleTrigger: { cumulativeThreshold: 3, counterexampleThreshold: 2, cadenceDays: 7, minimumIntervalMs: 0 },
  metrics: [
    {
      id: 'metric-a',
      label: 'Metric A',
      kind: 'counter',
      evaluator: { kind: 'code', ruleRef: 'rule-a' },
      trigger: { kind: 'distinct-counterexamples', threshold: 2 },
      verdictRule: { kind: 'counter-zero' },
    },
  ],
};
export const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [model],
    objectives: [{ id: 'obj', label: 'Objective', statement: 'Keep the behavior sound.', evaluationModelId: model.id }],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [{ unitId: 'D1', hookId: 'd1-test', unitState: 'evaluable', objectives: [{ objectiveId: 'obj' }] }],
  },
};

/** Same one-Objective catalog with a different cumulative trigger threshold (minimum interval 0). */
export function catalogWithThreshold(cumulativeThreshold) {
  return {
    ...catalog,
    registry: {
      ...catalog.registry,
      evaluationModels: [{ ...model, cycleTrigger: { ...model.cycleTrigger, cumulativeThreshold } }],
    },
  };
}

export function trace(invocationId, terminalAt) {
  return {
    terminal: {
      invocationId,
      terminalAt,
      ownerUserId: 'owner-1',
      threadId: 'source-thread',
      catId: 'cat-a',
      terminalKind: 'completed',
      inputMessageId: null,
      outputMessageId: null,
      toolCalls: [{ toolName: 'example_tool', outcome: 'ok' }],
    },
    summary: { segments: [{ segmentId: 'D1', status: 'observed', contentHash: 'sha256:x' }] },
  };
}

export const principal = { userId: 'owner-1', catId: 'cat-default', threadId: 'thread_eval_f257_obj' };
export const submission = {
  objectiveId: 'obj',
  metrics: [
    { id: 'metric-a', conclusion: { kind: 'count', value: 0, howCounted: 'inspected page' }, evidenceRefs: [] },
  ],
  overall: 'complete',
  counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
  coverageAssessment: {
    status: 'adequate',
    rationale: 'The inspected window is covered by the declared metrics and detectors.',
    findings: [],
  },
};

/** idle → requested (frozen window [0, 1000]) → retriggered → stalled, through the store CAS only. */
export async function stalledRecord(store) {
  const idle = await store.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:D1@1' });
  const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
  assert.equal(await store.request(idle, requested), true);
  const retriggered = { ...requested, evalStatus: 'retriggered', retriggeredAt: 1_100 };
  assert.equal(await store.transition(requested, retriggered), true);
  const stalled = { ...retriggered, evalStatus: 'stalled', stalledAt: 1_200, stalledAlertMessageId: 'alert' };
  assert.equal(await store.transition(retriggered, stalled), true);
  return store.current('owner-1', 'obj');
}
