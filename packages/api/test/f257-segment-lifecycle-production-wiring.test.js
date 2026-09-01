/**
 * F257 Gate 1 regression: the production composition owns the lifecycle
 * surface. Route tests that register individual plugins cannot prove this.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const openApps = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function fakeTraceStore() {
  return {
    listTracedThreadIds: async () => [],
    queryWindow: async () => [],
    getReplaySnapshot: async () => null,
  };
}

function fakeOverrideStore() {
  return {
    listOverrides: async () => [],
    listEvents: async () => [],
    listVersions: async () => [],
  };
}

describe('F257 production segment lifecycle surface', () => {
  test('one production-owned registrar exposes lifecycle read, replay, evaluation, override and governance decision routes', async () => {
    const { registerSegmentLifecycleSurface } = await import('../dist/routes/segment-lifecycle-surface.js');
    const app = Fastify({ logger: false });
    openApps.push(app);
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'owner-1';
    });

    await registerSegmentLifecycleSurface(app, {
      traceStore: fakeTraceStore(),
      overrideStore: fakeOverrideStore(),
    });
    await app.ready();

    const lifeline = await app.inject({ method: 'GET', url: '/api/segment-lifeline/D11' });
    assert.equal(lifeline.statusCode, 200, lifeline.body);

    const replay = await app.inject({ method: 'GET', url: '/api/segment-lifeline/D11/replay' });
    assert.equal(replay.statusCode, 400, 'registered replay route must reject missing coordinates, not 404');

    const evaluation = await app.inject({ method: 'GET', url: '/api/segment-evaluation/D11' });
    assert.equal(evaluation.statusCode, 503, 'registered evaluation route must report unavailable runtime, not 404');

    const overrides = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(overrides.statusCode, 200, overrides.body);
    assert.deepEqual(overrides.json(), { overrides: [] });

    const governanceDecision = await app.inject({
      method: 'POST',
      url: '/api/harness-governance-candidates/EC-missing/approve',
    });
    assert.equal(
      governanceDecision.statusCode,
      503,
      'registered governance route must report unavailable stores, not 404',
    );
  });

  test('index.ts wires the canonical stores into the registrar and prompt content routes', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const lifelineSource = readFileSync(new URL('../src/routes/segment-lifeline.ts', import.meta.url), 'utf8');

    assert.match(source, /bootstrapHookOverrideStore\(redis\)/);
    assert.match(source, /registerSegmentLifecycleSurface\(app,\s*\{/);
    assert.match(source, /traceStore:\s*getTraceStore\(\)\s*\?\?\s*undefined/);
    assert.match(source, /^\s*guardRejectionLog,\s*$/m);
    assert.match(source, /^\s*overrideStore:\s*hookOverrideStore,\s*$/m);
    assert.match(source, /^\s*messageStore,\s*$/m);
    assert.match(source, /^\s*threadStore,\s*$/m);
    assert.match(source, /const runtime = getObjectiveEvaluationRuntime\(\)\s*\?\?\s*undefined/);
    assert.match(source, /^\s*runtime,\s*$/m);
    assert.match(source, /const candidateStore = redis \? new CandidateStore\(redis\) : undefined/);
    assert.match(source, /runtime\.setPostCommitHook\(/);
    assert.match(source, /createGovernanceWorker\(\{/);
    assert.match(source, /AnthropicGovernanceDecisionGenerator/);
    assert.match(source, /^\s*decisionGenerator,\s*$/m);
    assert.match(source, /canEditHook:.*manifest\.safetyTier !== 'readonly'/);
    assert.match(source, /resolveSegmentState:\s*async/);
    assert.match(source, /registry\.getContentOverride\(hookId\)/);
    assert.match(source, /registry\.getActiveVersion\(hookId\)/);
    assert.match(source, /^\s*candidateStore,\s*$/m);
    assert.match(source, /F257:\s*\{ adapter: new F257ApprovalAdapter\(candidateStore\) \}/);
    assert.match(source, /resolvePendingCandidateCount:\s*candidateStore/);
    assert.match(source, /app\.register\(promptInjectionRoutes,\s*\{\s*overrideStore:\s*hookOverrideStore\s*\}\)/);
    assert.match(
      source,
      /app\.register\(promptInjectionManifestRoutes,\s*\{\s*overrideStore:\s*hookOverrideStore\s*\}\)/,
    );
    assert.doesNotMatch(
      lifelineSource,
      /SegmentJudgmentCache|segment-judgment-engine/,
      'production lifeline must not import either legacy judgment truth source',
    );
  });
});
