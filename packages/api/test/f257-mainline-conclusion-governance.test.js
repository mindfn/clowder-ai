import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';

// ============================================================================
// F257 mainline REAL end-to-end acceptance: the five-ring mid-segment.
//
//   signal ─► eval ─► conclusion(verdict) ─► governance ─► candidate/skip
//          ─► approval ─► override ─► re-eval
//
// This REPLACES the earlier helper-assembly version (which proved the
// conclusion->governance advance by calling `objectiveJudgmentToCachedJudgment`
// / `buildVersionChain` / `deriveActiveStage` directly — sol: "helper-assembled
// green doesn't count"). Every leg here is driven through a REAL seam:
//   - tracing→eval→conclusion: real `ObjectiveEvaluationRuntime.append(...)`
//     commits a real rolled-up verdict (no fixture judgment);
//   - conclusion→governance→candidate: a real governance worker on the runtime's
//     post-commit hook maps the verdict into a persisted `Candidate` (frozen
//     judgment-schema-v1 §3: EC-*, originKind eval-verdict);
//   - the candidate surfaces through the REAL HTTP route
//     `GET /api/segment-lifeline/:id` (registerSegmentLifecycleSurface + inject),
//     flipping `actionable` from the honest `unavailable` gap to a real pending
//     governance candidate — NOT the synthesized never-actionable node;
//   - approval→override: the REAL `POST /api/prompt-hooks/:id/override` executor;
//   - override→re-eval: a `PatchTrial` outcome (frozen schema §4).
//
// TDD status: leg 1 (→candidate surfaced) is the green target of this slice.
// The approval→PatchTrial→re-eval legs are RED until the executor is wired to
// the candidate store — they encode the remaining contract, not a passing state.
// ============================================================================

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { registerSegmentLifecycleSurface } = await import('../dist/routes/segment-lifecycle-surface.js');
// NEW mid-segment production seams (F257 conclusion->governance->candidate).
// Until these exist in dist, this file is RED at import — the honest "not built
// yet" signal for the bounded mid-segment.
const { CandidateStore } = await import('../dist/infrastructure/harness-eval/governance/CandidateStore.js');
const { createGovernanceWorker } = await import('../dist/infrastructure/harness-eval/governance/GovernanceWorker.js');

const OWNER = 'owner-1';

// ── In-memory Redis double (same contract the runtime + stores use) ─────────
class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.sets = new Map();
    this.zsets = new Map();
    this.hashes = new Map();
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
    const had = this.strings.has(key) || this.sets.has(key) || this.zsets.has(key) || this.hashes.has(key);
    this.strings.delete(key);
    this.sets.delete(key);
    this.zsets.delete(key);
    this.hashes.delete(key);
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
    if (this.hashes.has(key)) return 'hash';
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
  async hset(key, field, value) {
    const map = this.hashes.get(key) ?? new Map();
    map.set(field, value);
    this.hashes.set(key, map);
    return 1;
  }
  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  async hvals(key) {
    return [...(this.hashes.get(key) ?? new Map()).values()];
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

// ── Objective catalog: one segment (S13) with a counter that trips at 3 ─────
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
      ownerUserId: OWNER,
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

// ── Faithful recording override store (same contract as the real store, used
// by the two established route tests). The ROUTE + WORKER are real; this stands
// in for the Redis-backed HookOverrideStore. ─────────────────────────────────
function recordingOverrideStore() {
  const calls = [];
  const overrides = new Map();
  const events = [];
  return {
    calls,
    overrides,
    async enable(hookId, actorId, opts) {
      calls.push({ method: 'enable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: true });
      events.push({ hookId, action: 'enable', at: 100 });
    },
    async disable(hookId, actorId, opts) {
      calls.push({ method: 'disable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: false });
      events.push({ hookId, action: 'disable', at: 100 });
    },
    async rollback(hookId, actorId, opts) {
      calls.push({ method: 'rollback', hookId, actorId, opts });
      overrides.delete(hookId);
      events.push({ hookId, action: 'rollback', at: 100 });
    },
    async getOverride(hookId) {
      return overrides.get(hookId) ?? null;
    },
    async listOverrides() {
      return [...overrides.values()];
    },
    async listEvents() {
      return events;
    },
    async listVersions() {
      return [];
    },
  };
}

async function bootSurface(redis, runtime, overrideStore, candidateStore) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = OWNER;
  });
  await registerSegmentLifecycleSurface(app, {
    traceStore: {
      listTracedThreadIds: async () => ['thread-1'],
      queryWindow: async () => [],
      getReplaySnapshot: async () => null,
    },
    overrideStore,
    runtime,
    // The real actionable-governance projection: read pending Candidates for
    // this segment. Honest gap (null) when the store has none.
    resolvePendingCandidateCount: candidateStore ? (segmentId) => candidateStore.countPending(segmentId) : undefined,
  });
  await app.ready();
  return app;
}

const openApps = [];
after(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('F257 mainline REAL e2e: conclusion -> governance -> candidate', () => {
  before(() => {
    // Owner gate for the override (approval) executor.
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
  });

  test('LEG 1 — a real retire-candidate verdict surfaces a real pending Candidate through the live route', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);

    // Wire the REAL governance worker onto the runtime's post-commit hook —
    // mirroring how guard-threshold-escalation registers on setPostAppendHook.
    runtime.setPostCommitHook(createGovernanceWorker({ candidateStore, catalog }));

    // tracing → eval: three distinct counterexamples trip the counter trigger,
    // the Objective evaluates and commits a REAL rolled-up verdict.
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    // conclusion: the committed verdict is retire-candidate (measured + breached).
    const judgment = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    assert.ok(judgment, 'a real eval run must have committed a judgment');
    assert.equal(judgment.verdict, 'retire-candidate');

    // governance → candidate: the worker persisted a real Candidate for S13.
    const pending = await candidateStore.countPending('S13');
    assert.equal(pending, 1, 'the retire-candidate verdict must open exactly one governance Candidate');
    const [candidate] = await candidateStore.listBySegment('S13');
    assert.match(candidate.candidateId, /^EC-/, 'eval-produced candidates use the EC-* namespace');
    assert.equal(candidate.originKind, 'eval-verdict');
    assert.equal(candidate.type, 'retire-candidate');
    assert.equal(candidate.status, 'proposed');
    assert.ok(candidate.evidence.anchors.includes(judgment.judgmentId), 'candidate must anchor its judgment');

    // the candidate surfaces through the REAL HTTP read model as actionable —
    // NOT the synthesized never-actionable governance node.
    const app = await bootSurface(redis, runtime, recordingOverrideStore(), candidateStore);
    openApps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/segment-lifeline/S13' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.actionable.source, 'candidate-count', 'projection is wired — not the honest gap');
    assert.equal(body.actionable.candidateCount, 1);
    assert.equal(body.actionable.stage, 'governance');
  });

  test('REGRESSION GUARD — without the candidate projection the route stays honestly `unavailable`, never a fabricated pending', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    // Surface booted WITHOUT a candidate store (production's current unwired state).
    const app = await bootSurface(redis, runtime, recordingOverrideStore(), null);
    openApps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/segment-lifeline/S13' });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.actionable.source, 'unavailable');
    assert.equal(body.actionable.candidateCount, null, 'unknown, never fabricated 0-or-pending');
  });

  test('LEG 2 (CONTRACT, red until executor wired) — approval via the override route advances the Candidate and opens a PatchTrial', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(createGovernanceWorker({ candidateStore, catalog }));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const [candidate] = await candidateStore.listBySegment('S13');
    assert.equal(candidate.status, 'proposed');

    const overrideStore = recordingOverrideStore();
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);

    // governance → approval → override: the operator's approval IS the override
    // POST. On success the executor must disable the hook AND advance the
    // candidate proposed→approved AND open a PatchTrial (frozen schema §4).
    const approve = await app.inject({
      method: 'POST',
      url: '/api/prompt-hooks/s13-doc/override',
      payload: { action: 'disable', reason: 'retire-candidate EC trial (operator approved)' },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(overrideStore.calls.at(-1)?.method, 'disable', 'override executor ran');

    const advanced = await candidateStore.get(candidate.candidateId);
    assert.equal(advanced.status, 'approved', 'approval must advance the candidate off the pending queue');
    assert.equal(advanced.approval.approvedBy, OWNER, 'operator id is recorded, never cat-filled');

    const trials = await candidateStore.listPatchTrials(candidate.candidateId);
    assert.equal(trials.length, 1, 'approval opens exactly one PatchTrial');
    assert.match(trials[0].trialId, /^pt-EC-/);
    assert.equal(trials[0].mechanism, 'override-disable');

    // and the pending queue empties — the route reports 0 actionable.
    const res = await app.inject({ method: 'GET', url: '/api/segment-lifeline/S13' });
    assert.equal(res.json().actionable.candidateCount, 0);
  });
});
