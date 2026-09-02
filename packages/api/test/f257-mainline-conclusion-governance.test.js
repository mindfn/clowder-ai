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
//   - candidate→approval: REAL Approval Hub aggregation + decision route;
//   - approval→override: content draft writes v+1 or activates a prior version;
//   - override→re-eval: the next ordinary Unit run feeds governance again.
//
// All legs are required to stay green; no helper-built judgment or lifecycle
// chain may substitute for these production seams. No PatchTrial/固化 step
// exists between approval and the next ordinary evaluation round.
// ============================================================================

const { ObjectiveEvaluationRuntime, produceObjectiveVerdictDecision } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { registerSegmentLifecycleSurface } = await import('../dist/routes/segment-lifecycle-surface.js');
const { approvalHubRoutes } = await import('../dist/routes/approval-hub-routes.js');
const { ApprovalProducerRegistry } = await import('../dist/domains/approval-hub/ApprovalProducerRegistry.js');
const { F257ApprovalAdapter } = await import('../dist/domains/approval-hub/adapters/F257ApprovalAdapter.js');
const { APPROVAL_PRODUCER_IDS } = await import('@cat-cafe/shared');
// Mid-segment production seams (F257 conclusion->governance->candidate).
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
  verdictRule: { kind: 'counter-zero' },
  evaluator: { kind: 'code', ruleRef: 'tool-schema-failure' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};
const semanticMetric = {
  id: 'tool-choice-correctness',
  label: 'tool choice correctness',
  kind: 'semantic',
  verdictRule: { kind: 'evidence-only' },
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

function governanceWorker(candidateStore, runtimeCatalog = catalog, overrides = {}) {
  return createGovernanceWorker({
    candidateStore,
    catalog: runtimeCatalog,
    decisionGenerator: {
      async decide(input) {
        return {
          action: 'change-content',
          contentDraft: {
            proposedContent: `${input.currentContent}\n\n# governed-v${input.currentVersion + 1}`,
            rationale: `Revise v${input.currentVersion} from the measured conclusion.`,
          },
          rationale: `The current v${input.currentVersion} conclusion warrants a content revision.`,
        };
      },
    },
    resolveSegmentState: () => ({ currentContent: 'base-content-v1', currentVersion: 1 }),
    ...overrides,
  });
}

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
          contentHash: 'hash-stable',
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

function runtimeFor(redis, annotations, episodes, runtimeCatalog = catalog) {
  return new ObjectiveEvaluationRuntime(redis, runtimeCatalog, annotations, {
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
function recordingOverrideStore(options = {}) {
  const calls = [];
  const overrides = new Map();
  const versionContents = new Map([[1, 'base-content-v1']]);
  const events = [];
  return {
    calls,
    overrides,
    versionContents,
    async enable(hookId, actorId, opts) {
      calls.push({ method: 'enable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: true });
      events.push({ hookId, action: 'enable', at: 100 });
    },
    async disable(hookId, actorId, opts) {
      await options.beforeDisable?.();
      calls.push({ method: 'disable', hookId, actorId, opts });
      overrides.set(hookId, { hookId, enabled: false });
      events.push({ hookId, action: 'disable', at: 100 });
    },
    async setContentOverride(hookId, content, actorId, opts) {
      await options.beforeSetContent?.();
      const existing = overrides.get(hookId);
      const activeEpochVersion = (existing?.activeEpochVersion ?? 1) + 1;
      calls.push({ method: 'setContentOverride', hookId, content, actorId, opts, activeEpochVersion });
      overrides.set(hookId, {
        ...(existing ?? {}),
        hookId,
        contentOverride: content,
        activeEpochVersion,
      });
      versionContents.set(activeEpochVersion, content);
      events.push({ hookId, action: 'content-set', at: 100, epochVersion: activeEpochVersion });
      await options.afterSetContent?.();
    },
    async activateVersion(hookId, epochVersion, actorId, opts) {
      await options.beforeActivateVersion?.();
      const content = versionContents.get(epochVersion);
      if (content === undefined) throw new Error(`No content snapshot for version ${epochVersion}`);
      calls.push({ method: 'activateVersion', hookId, epochVersion, actorId, opts });
      if (epochVersion === 1) {
        overrides.delete(hookId);
      } else {
        overrides.set(hookId, { hookId, contentOverride: content, activeEpochVersion: epochVersion });
      }
      events.push({ hookId, action: 'version-activate', at: 100, epochVersion });
    },
    async rollback(hookId, actorId, opts) {
      calls.push({ method: 'rollback', hookId, actorId, opts });
      overrides.delete(hookId);
      events.push({ hookId, action: 'rollback', at: 100 });
    },
    async getOverride(hookId) {
      return overrides.get(hookId) ?? null;
    },
    async getActiveVersion(hookId) {
      return overrides.get(hookId)?.activeEpochVersion ?? 1;
    },
    async listOverrides() {
      return [...overrides.values()];
    },
    async listEvents() {
      return events;
    },
    async listVersions() {
      return [...versionContents.entries()].map(([version, contentPreview]) => ({ version, contentPreview }));
    },
  };
}

async function bootSurface(_redis, runtime, overrideStore, candidateStore, sessionUserId = OWNER) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = sessionUserId;
  });
  await registerSegmentLifecycleSurface(app, {
    traceStore: {
      listTracedThreadIds: async () => ['thread-1'],
      queryWindow: async () => [],
      getReplaySnapshot: async () => null,
    },
    overrideStore,
    runtime,
    candidateStore: candidateStore ?? undefined,
    governanceNow: () => 104,
    // The real actionable-governance projection: read pending Candidates for
    // this segment. Honest gap (null) when the store has none.
    resolvePendingCandidateCount: candidateStore
      ? (ownerUserId, segmentId) => candidateStore.countPending(ownerUserId, segmentId)
      : undefined,
  });
  const f257Adapter = new F257ApprovalAdapter(candidateStore ?? undefined);
  const approvalBindings = Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((featureId) => [
      featureId,
      {
        adapter:
          featureId === 'F257'
            ? f257Adapter
            : {
                featureId,
                async listPending() {
                  return [];
                },
                async listSettled() {
                  return [];
                },
              },
      },
    ]),
  );
  await app.register(approvalHubRoutes, { registry: new ApprovalProducerRegistry(approvalBindings) });
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

  test('VERDICT CONTRACT — readiness threshold never becomes the decision threshold', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const firstTraceAt = 1_000;
    const cadenceNow = firstTraceAt + 7 * 24 * 60 * 60 * 1000;
    const oneEpisode = episode(1);
    oneEpisode.terminal.terminalAt = firstTraceAt;
    oneEpisode.summary.timestamp = firstTraceAt;
    const oneAnnotation = annotation(1);
    oneAnnotation.createdAt = firstTraceAt;
    oneAnnotation.episodeRef.terminalAt = firstTraceAt;
    const runtime = runtimeFor(redis, annotations, [oneEpisode]);
    await runtime.append(oneAnnotation);
    assert.equal(await runtime.judgments.latest(OWNER, 'tool-access-correct-use'), null, '1/3 is not trigger-ready');

    // Cadence forces the Unit run before the 3-counterexample readiness trigger.
    // The explicit counter-zero verdict rule still treats count=1 as a breach.
    await runtime.runCadenceMetrics(OWNER, cadenceNow);
    const judgment = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    assert.equal(judgment.metricResults[0].value.count, 1);
    assert.equal(judgment.metricResults[0].value.threshold, 3, 'result retains the independent trigger contract');
    assert.equal(judgment.verdict, 'retire-candidate');
    assert.equal(judgment.verdictDecision.metricDecisions[0].rule.kind, 'counter-zero');
    assert.deepEqual(judgment.verdictDecision.metricDecisions[0].measurement, {
      kind: 'count',
      value: 1,
      howCounted: 'tool-schema-failure-count:distinct-counterexamples(1)',
    });
    assert.doesNotMatch(
      judgment.verdictDecision.metricDecisions[0].measurement.howCounted,
      /trace-corpus|denominator/u,
      'counter decisions must never invent a denominator',
    );
    redis.strings.delete(`harness-evaluation-snapshot:${judgment.snapshotId}`);
    assert.equal(
      (await runtime.judgments.latest(OWNER, 'tool-access-correct-use')).judgmentId,
      judgment.judgmentId,
      'a current v2 judgment remains readable without re-normalizing from a snapshot',
    );
  });

  test('RATE CONTRACT — rate-minimum normalizes badness and pins one breached metric', () => {
    const metricDefinitions = [
      {
        id: 'success-rate',
        label: 'success',
        kind: 'rate',
        verdictRule: { kind: 'rate-minimum', minimum: 0.9 },
        evaluator: { kind: 'code', ruleRef: 'success-rate' },
        trigger: { kind: 'minimum-sample', minimum: 1, windowMs: 1000 },
      },
      {
        id: 'incidental-rate',
        label: 'incidental',
        kind: 'rate',
        verdictRule: { kind: 'rate-maximum', maximum: 0.95 },
        evaluator: { kind: 'code', ruleRef: 'incidental-rate' },
        trigger: { kind: 'minimum-sample', minimum: 1, windowMs: 1000 },
      },
    ];
    const results = [
      {
        resultId: 'r-success',
        snapshotId: 'snapshot-rate',
        ownerUserId: OWNER,
        objectiveId: 'rate-objective',
        metricId: 'success-rate',
        kind: 'rate',
        value: { kind: 'rate', numerator: 5, denominator: 10, rate: 0.5 },
        evaluatedAt: 1,
      },
      {
        resultId: 'r-incidental',
        snapshotId: 'snapshot-rate',
        ownerUserId: OWNER,
        objectiveId: 'rate-objective',
        metricId: 'incidental-rate',
        kind: 'rate',
        value: { kind: 'rate', numerator: 9, denominator: 10, rate: 0.9 },
        evaluatedAt: 1,
      },
    ];
    const conclusion = produceObjectiveVerdictDecision(
      { evaluationModelVersion: 'v1', metricDefinitions, samples: [] },
      results,
      metricDefinitions.map((metric) => ({ metricId: metric.id, status: 'evaluated' })),
    );

    assert.equal(conclusion.verdict, 'retire-candidate');
    assert.equal(conclusion.decision.primaryMetricId, 'success-rate');
    assert.equal(conclusion.decision.measurement.kind, 'rate-badness');
    assert.equal(conclusion.decision.measurement.value, 0.5, '50% success becomes 50% normalized badness');
    assert.match(conclusion.decision.measurement.howCounted, /^success-rate:1-/);
  });

  test('SCHEMA REPAIR — a legacy durable judgment is normalized and re-enters governance without a manual eval trigger', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const versionedCatalog = structuredClone(catalog);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)], versionedCatalog);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const current = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    const { schemaVersion: _schema, verdict: _verdict, verdictDecision: _decision, ...legacy } = current;
    redis.strings.set(`harness-objective-judgment:${current.judgmentId}`, JSON.stringify(legacy));
    // Registry evolution must not rewrite history. The legacy row was evaluated
    // against the immutable v1 snapshot; current v2 deliberately changes the
    // counter to evidence-only so consulting the live registry would flip the
    // historical conclusion to unmeasurable.
    versionedCatalog.registry.evaluationModels[0].ruleVersion = 'v2';
    versionedCatalog.registry.evaluationModels[0].metrics[0].verdictRule = { kind: 'evidence-only' };

    const candidateStore = new CandidateStore(redis);
    const createdNotifications = [];
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        onCandidateCreated: (candidate) => createdNotifications.push(candidate.candidateId),
      }),
    );
    await runtime.reconcileLatestJudgments(OWNER);

    const repaired = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    assert.equal(repaired.schemaVersion, 2);
    assert.equal(repaired.verdict, 'retire-candidate');
    assert.equal(repaired.verdictDecision.schemaVersion, 2);
    assert.equal(repaired.evaluationModelVersion, 'v1');
    assert.equal(repaired.verdictDecision.evaluationModelVersion, 'v1');
    assert.equal(repaired.verdictDecision.metricDecisions[0].rule.kind, 'counter-zero');
    assert.equal(repaired.verdictDecision.measurement.kind, 'count');
    assert.equal(await candidateStore.countPending(OWNER, 'S13'), 1, 'repair re-emits through the idempotent worker');
    await runtime.reconcileLatestJudgments(OWNER);
    assert.equal(await candidateStore.countPending(OWNER, 'S13'), 1, 'cold-start reconciliation is idempotent');
    assert.equal(createdNotifications.length, 1, 'repair emits one Approval Hub refresh signal, never duplicates');
  });

  test('SCHEMA FAIL-CLOSED — a malformed v2 conclusion is rebuilt from its immutable snapshot', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const current = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    const corrupted = structuredClone(current);
    corrupted.verdict = 'alive';
    corrupted.verdictDecision.measurement.value = -1;
    redis.strings.set(`harness-objective-judgment:${current.judgmentId}`, JSON.stringify(corrupted));

    const repaired = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    assert.equal(repaired.verdict, 'retire-candidate', 'stored verdict cannot contradict its metric decision vector');
    assert.equal(repaired.verdictDecision.measurement.value, 3, 'invalid measurements are never accepted as truth');
    assert.equal(
      JSON.parse(redis.strings.get(`harness-objective-judgment:${current.judgmentId}`)).verdict,
      'retire-candidate',
      'the deterministic repair is persisted for later cold reads',
    );
  });

  test('LEG 1 — a real retire-candidate verdict surfaces a real pending Candidate through the live route', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);

    // Wire the REAL governance worker onto the runtime's post-commit hook —
    // mirroring how guard-threshold-escalation registers on setPostAppendHook.
    let decisionInput;
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        resolveSegmentState: () => ({ currentContent: 'current-content-v2', currentVersion: 2 }),
        decisionGenerator: {
          async decide(input) {
            decisionInput = input;
            return {
              action: 'change-content',
              contentDraft: { proposedContent: 'proposed-content-v3', rationale: 'Address the measured failure.' },
              rationale: 'The evaluation conclusion supports revising the current content.',
            };
          },
        },
      }),
    );

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
    const pending = await candidateStore.countPending(OWNER, 'S13');
    assert.equal(pending, 1, 'the retire-candidate verdict must open exactly one governance Candidate');
    assert.equal(
      await candidateStore.countPending('different-owner', 'S13'),
      0,
      "candidate indexes are owner-scoped and never leak another operator's governance item",
    );
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    assert.match(candidate.candidateId, /^EC-/, 'eval-produced candidates use the EC-* namespace');
    assert.equal(candidate.originKind, 'eval-verdict');
    assert.equal(candidate.type, 'retire-candidate');
    assert.equal(candidate.status, 'proposed');
    assert.ok(candidate.evidence.anchors.includes(judgment.judgmentId), 'candidate must anchor its judgment');
    assert.deepEqual(
      {
        segmentId: decisionInput.segmentId,
        currentContent: decisionInput.currentContent,
        currentVersion: decisionInput.currentVersion,
        verdict: decisionInput.verdict,
      },
      { segmentId: 'S13', currentContent: 'current-content-v2', currentVersion: 2, verdict: 'retire-candidate' },
    );
    assert.match(decisionInput.conclusion, /tool-schema-failure-count/);
    assert.deepEqual(decisionInput.counterexampleAnchors.sort(), ['ann-1', 'ann-2', 'ann-3']);
    assert.equal(candidate.proposedAction.mechanism, 'override-content');
    assert.equal(candidate.proposedAction.sourceVersion, 2);
    assert.equal(candidate.proposedAction.contentDraft.proposedContent, 'proposed-content-v3');

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
    const approvalHub = await app.inject({ method: 'GET', url: '/api/approval-hub/pending' });
    assert.equal(approvalHub.statusCode, 200, approvalHub.body);
    assert.deepEqual(
      approvalHub.json().items.map((item) => [item.sourceFeatureId, item.proposalId]),
      [['F257', candidate.candidateId]],
      'the persisted Candidate is a real operator-visible Approval Hub item',
    );
    const otherOwnerApp = await bootSurface(
      redis,
      runtime,
      recordingOverrideStore(),
      candidateStore,
      'different-owner',
    );
    openApps.push(otherOwnerApp);
    const otherOwnerHub = await otherOwnerApp.inject({ method: 'GET', url: '/api/approval-hub/pending' });
    assert.equal(otherOwnerHub.json().items.length, 0, "Approval Hub does not expose another owner's Candidate");
    const crossOwnerApprove = await otherOwnerApp.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.ok(
      crossOwnerApprove.statusCode === 403 || crossOwnerApprove.statusCode === 404,
      `another owner must be blocked before mutation (received ${crossOwnerApprove.statusCode})`,
    );
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

  test('ATTRIBUTION GUARD — one Objective breach never opens candidates for every member segment', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const multiSegmentCatalog = structuredClone(catalog);
    multiSegmentCatalog.manifest.units.push({
      unitId: 'S14',
      hookId: 's14-unattributed',
      unitState: 'evaluable',
      objectives: [{ objectiveId: 'tool-access-correct-use' }],
    });
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)], multiSegmentCatalog);
    runtime.setPostCommitHook(governanceWorker(candidateStore, multiSegmentCatalog));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const judgment = await runtime.judgments.latest(OWNER, 'tool-access-correct-use');
    assert.deepEqual(judgment.unitRefs.map((ref) => ref.unitId).sort(), ['S13', 'S14']);
    assert.deepEqual(judgment.verdictDecision.targetSegmentIds, ['S13']);
    assert.equal(await candidateStore.countPending(OWNER, 'S13'), 1);
    assert.equal(
      await candidateStore.countPending(OWNER, 'S14'),
      0,
      'unattributed Unit members must never receive content-version candidates',
    );
  });

  test('POLICY GUARD — a protected hook never receives an approval card for an action the executor must reject', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    let checkedHookId = null;
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        canEditHook: (hookId) => {
          checkedHookId = hookId;
          return false;
        },
      }),
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    assert.equal(checkedHookId, 'S13', 'policy guard receives the canonical HookRegistry id, not the asset slug');
    assert.equal(await candidateStore.countPending(OWNER, 'S13'), 0);
  });

  test('LEG 2 — operator approval applies the drafted content as v2 and closes the Candidate', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    assert.equal(candidate.status, 'proposed');

    const overrideStore = recordingOverrideStore();
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);

    assert.equal(candidate.proposedAction.mechanism, 'override-content');
    assert.match(candidate.proposedAction.contentDraft.proposedContent, /governed-v2/);

    // governance → Approval Hub decision → override. One approval writes the
    // operator-visible draft as v2 and settles the Candidate. No trial opens.
    const approve = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
      payload: { note: 'apply the proposed v2 content' },
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(overrideStore.calls.at(-1)?.method, 'setContentOverride', 'content override executor ran');
    assert.equal(
      overrideStore.calls.at(-1)?.hookId,
      'S13',
      'override executor uses the canonical HookRegistry id, never the manifest asset slug',
    );
    assert.equal(overrideStore.calls.at(-1)?.activeEpochVersion, 2, 'approved content creates v2');
    assert.equal(overrideStore.calls.at(-1)?.content, candidate.proposedAction.contentDraft.proposedContent);

    const advanced = await candidateStore.get(candidate.candidateId);
    assert.equal(advanced.status, 'closed', 'one approval applies and settles the Candidate');
    assert.equal(advanced.approval.approvedBy, OWNER, 'operator id is recorded, never cat-filled');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
      payload: { note: 'apply the proposed v2 content' },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(overrideStore.calls.length, 1, 'approval retry does not create v3');

    const pendingHub = await app.inject({ method: 'GET', url: '/api/approval-hub/pending' });
    assert.equal(pendingHub.json().items.length, 0, 'approved Candidate leaves the pending approval queue');
    const settledHub = await app.inject({ method: 'GET', url: '/api/approval-hub/settled' });
    assert.deepEqual(
      settledHub.json().items.map((item) => [item.sourceFeatureId, item.proposalId, item.status]),
      [['F257', candidate.candidateId, 'approved']],
      'the operator decision remains durable and visible in Approval Hub history',
    );

    // and the pending queue empties — the route reports 0 actionable.
    const res = await app.inject({ method: 'GET', url: '/api/segment-lifeline/S13' });
    assert.equal(res.json().actionable.candidateCount, 0);
  });

  test('STALE APPROVAL — a draft cannot overwrite a newer content version', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    assert.equal(candidate.proposedAction.sourceVersion, 1);

    const overrideStore = recordingOverrideStore();
    await overrideStore.setContentOverride('S13', 'newer-external-v2', OWNER, { source: 'operator' });
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);
    const approve = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });

    assert.equal(approve.statusCode, 409, approve.body);
    assert.match(approve.body, /source_version_changed/);
    assert.equal(overrideStore.calls.length, 1, 'the newer v2 remains untouched');
    assert.equal((await overrideStore.getOverride('S13')).contentOverride, 'newer-external-v2');
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'proposed');
  });

  test('DECISION RACE — approve owns the durable transition before reject can settle', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');

    let releaseContentWrite;
    let contentWriteEntered;
    const entered = new Promise((resolve) => {
      contentWriteEntered = resolve;
    });
    const blocked = new Promise((resolve) => {
      releaseContentWrite = resolve;
    });
    const overrideStore = recordingOverrideStore({
      beforeSetContent: async () => {
        contentWriteEntered();
        await blocked;
      },
    });
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);

    const approving = app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
      payload: { note: 'approve wins the decision lease' },
    });
    await entered;
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'executing');

    const rejecting = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/reject`,
      payload: { note: 'must not race the accepted override' },
    });
    assert.equal(rejecting.statusCode, 409, rejecting.body);

    releaseContentWrite();
    const approved = await approving;
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'closed');
    assert.equal(overrideStore.calls.filter((call) => call.method === 'setContentOverride').length, 1);
  });

  test('APPROVAL RECOVERY — an interrupted override resumes from durable executing state', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');

    let attempts = 0;
    const overrideStore = recordingOverrideStore({
      beforeSetContent: async () => {
        attempts++;
        if (attempts === 1) throw new Error('simulated_override_failure_before_write');
      },
    });
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);

    const first = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.equal(first.statusCode, 500, first.body);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'executing');
    const recoveryHub = await app.inject({ method: 'GET', url: '/api/approval-hub/pending' });
    assert.deepEqual(
      recoveryHub.json().items.map((item) => item.proposalId),
      [candidate.candidateId],
      'an interrupted approval remains visible at the operator recovery surface',
    );
    assert.equal(
      recoveryHub.json().items[0].decisionMode,
      'resume-only',
      'the recovery card says continue instead of asking the operator to approve twice',
    );
    const recoveryLifeline = await app.inject({ method: 'GET', url: '/api/segment-lifeline/S13' });
    assert.equal(
      recoveryLifeline.json().actionable.candidateCount,
      1,
      'an interrupted approval remains actionable instead of disappearing from the lifeline',
    );

    const retry = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'closed');
    assert.equal(overrideStore.calls.filter((call) => call.method === 'setContentOverride').length, 1);
  });

  test('APPROVAL RECOVERY — retry after content write settles without creating another version', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    let failAfterWrite = true;
    const overrideStore = recordingOverrideStore({
      afterSetContent: async () => {
        if (failAfterWrite) {
          failAfterWrite = false;
          throw new Error('simulated_crash_after_content_write');
        }
      },
    });
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);

    const first = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.equal(first.statusCode, 500, first.body);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'executing');
    assert.equal(await overrideStore.getActiveVersion('S13'), 2, 'the first write already created v2');

    const retry = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'closed');
    assert.equal(overrideStore.calls.filter((call) => call.method === 'setContentOverride').length, 1);
    assert.equal(await overrideStore.getActiveVersion('S13'), 2, 'recovery must not create v3');
  });

  test('LEG 3 — the next ordinary eval starts another governance round on the current version', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const episodes = [episode(1), episode(2), episode(3)];
    const overrideStore = recordingOverrideStore();
    const runtime = runtimeFor(redis, annotations, episodes);
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        resolveSegmentState: () => ({
          currentContent: overrideStore.overrides.get('S13')?.contentOverride ?? 'base-content-v1',
          currentVersion: overrideStore.overrides.get('S13')?.activeEpochVersion ?? 1,
        }),
      }),
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const [firstCandidate] = await candidateStore.listBySegment(OWNER, 'S13');
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);
    const approve = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${firstCandidate.candidateId}/approve`,
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(await overrideStore.getActiveVersion('S13'), 2);

    // No special treatment window: three new ordinary counterexamples trigger
    // the same Unit evaluator, which feeds a second governance decision on v2.
    for (let index = 10; index < 13; index++) {
      episodes.push(episode(index));
      await runtime.append(annotation(index));
    }

    const candidates = await candidateStore.listBySegment(OWNER, 'S13');
    assert.equal(candidates.length, 2);
    assert.equal(
      candidates.find((candidate) => candidate.candidateId === firstCandidate.candidateId)?.status,
      'closed',
    );
    const nextCandidate = candidates.find((candidate) => candidate.candidateId !== firstCandidate.candidateId);
    assert.equal(nextCandidate.status, 'proposed');
    assert.match(nextCandidate.proposedAction.contentDraft.proposedContent, /governed-v3/);
    assert.equal(redis.hashes.has('harness-governance-patch-trial'), false, 'no PatchTrial persistence is created');
  });

  test('ROLLBACK — approval activates the proposed prior version and settles once', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        resolveSegmentState: () => ({ currentContent: 'content-v2', currentVersion: 2 }),
        decisionGenerator: {
          async decide() {
            return { action: 'rollback', rollbackToVersion: 1, rationale: 'Return to the prior stable version.' };
          },
        },
      }),
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    assert.equal(candidate.proposedAction.rollbackToVersion, 1);

    const overrideStore = recordingOverrideStore();
    overrideStore.versionContents.set(2, 'content-v2');
    overrideStore.overrides.set('S13', { hookId: 'S13', contentOverride: 'content-v2', activeEpochVersion: 2 });
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);
    const approve = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/approve`,
    });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(overrideStore.calls.at(-1)?.method, 'activateVersion');
    assert.equal(overrideStore.calls.at(-1)?.epochVersion, 1);
    assert.equal(await overrideStore.getActiveVersion('S13'), 1);
    assert.equal((await candidateStore.get(candidate.candidateId)).status, 'closed');
  });

  test('SKIP — a skip draft leaves the current version untouched and opens no Candidate', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(
      governanceWorker(candidateStore, catalog, {
        decisionGenerator: {
          async decide() {
            return { action: 'skip', rationale: 'Accumulate more evidence.' };
          },
        },
      }),
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    assert.equal(await candidateStore.countPending(OWNER, 'S13'), 0);
  });

  test('OPERATOR REJECT — settles the Approval Hub item without mutating the current version', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const candidateStore = new CandidateStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    runtime.setPostCommitHook(governanceWorker(candidateStore));
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const [candidate] = await candidateStore.listBySegment(OWNER, 'S13');
    const overrideStore = recordingOverrideStore();
    const app = await bootSurface(redis, runtime, overrideStore, candidateStore);
    openApps.push(app);
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/harness-governance-candidates/${candidate.candidateId}/reject`,
      payload: { note: 'keep observing; operator rejects this intervention' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    const rejectedCandidate = await candidateStore.get(candidate.candidateId);
    assert.equal(rejectedCandidate.status, 'rejected');
    assert.equal(rejectedCandidate.approval.approvedBy, null, 'a rejection never pollutes the approvedBy field');
    assert.equal(overrideStore.calls.length, 0, 'rejection never mutates the live prompt pipeline');

    const pendingHub = await app.inject({ method: 'GET', url: '/api/approval-hub/pending' });
    assert.equal(pendingHub.json().items.length, 0);
    const settledHub = await app.inject({ method: 'GET', url: '/api/approval-hub/settled' });
    assert.deepEqual(
      settledHub.json().items.map((item) => [item.proposalId, item.status]),
      [[candidate.candidateId, 'rejected']],
    );
  });
});
