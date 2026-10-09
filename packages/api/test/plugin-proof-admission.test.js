import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import {
  ProcessLocalProofAdmissionSection,
  ProofAdmissionUnavailable,
} from '../dist/domains/plugin/carrier/proof-admission-section.js';
import {
  EMPTY_REVIEW_PROOF_POLICY,
  ReviewProofAdmission,
} from '../dist/domains/plugin/carrier/review-proof-admission.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(runtime, section) {
  const instance = {
    pluginInstanceId: 'pi_proof',
    pluginId: 'fixture.proof',
    packageDigest: 'sha256:fixture',
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
    lifecycleRevision: 1,
  };
  const record = {
    pluginId: instance.pluginId,
    packageDigest: instance.packageDigest,
    manifest: { pluginId: instance.pluginId },
  };
  const grant = { pluginInstanceId: instance.pluginInstanceId, grantRevision: 1, effectiveGrants: [] };
  const state = { instances: [instance], packages: [record], grants: [grant] };
  const inventory = {
    snapshot: async () => structuredClone(state),
    transaction: async (work) =>
      work({ instances: { get: () => instance, put: (next) => Object.assign(instance, next) } }),
  };
  return {
    instance,
    grant,
    state,
    inventory,
    carrier: new BundledPluginRuntimeCarrier({
      inventory,
      proofAdmissionSection: section,
      runtimes: [{ claims: () => true, start: async () => {}, ...runtime }],
    }),
  };
}

test('stop intent invalidates proof activation while closed waits for cleanup', async () => {
  const cleanup = deferred();
  const { carrier } = fixture({ stop: () => cleanup.promise, invoke: async () => ({ covered: true }) });
  const started = await carrier.start('pi_proof');
  assert.equal(
    typeof carrier.captureProofActivation,
    'function',
    'carrier must expose Host-only actual activation capture',
  );
  const captured = carrier.captureProofActivation('pi_proof');
  assert.equal(captured.isCurrent(), true);
  let closed = false;
  started.closed.then(() => {
    closed = true;
  });
  const stopping = carrier.stop('pi_proof');
  assert.equal(captured.isCurrent(), false);
  await Promise.resolve();
  assert.equal(closed, false);
  cleanup.resolve();
  await stopping;
  await started.closed;
  assert.equal(closed, true);
});

const input = { repoFullName: 'owner/repo', prNumber: 1, triggerCommentId: 42 };
async function proofFixture(invoke = async () => ({ covered: true, triggerCommentId: 42, observedAt: 10 })) {
  const section = new ProcessLocalProofAdmissionSection();
  const calls = [];
  const h = fixture(
    {
      stop: async () => {},
      invoke: async (...args) => {
        calls.push(args);
        return invoke(...args);
      },
    },
    section,
  );
  await h.carrier.start('pi_proof');
  const policy = {
    version: 1,
    revision: 1,
    entries: [
      {
        purpose: 'review-trigger-coverage',
        pluginId: h.instance.pluginId,
        instanceId: 'pi_proof',
        packageDigest: h.instance.packageDigest,
        provenanceRef: 'fixture:approved-closure',
        issuerSourceRef: 'fixture:issuer-only',
      },
    ],
  };
  const options = {
    inventory: h.inventory,
    policy: { snapshot: async () => structuredClone(policy) },
    provenance: { resolve: async () => 'fixture:approved-closure' },
    carrier: h.carrier,
    section,
  };
  return { ...h, section, calls, policy, options, proof: new ReviewProofAdmission(options) };
}

for (const invalid of ['empty', 'purpose', 'digest', 'provenance', 'ambiguous']) {
  test(`untrusted ${invalid} is refused before query or mutation`, async () => {
    const h = await proofFixture();
    if (invalid === 'empty') h.options.policy.snapshot = async () => EMPTY_REVIEW_PROOF_POLICY;
    if (invalid === 'purpose') h.policy.entries[0].purpose = 'ordinary-install';
    if (invalid === 'digest') h.policy.entries[0].packageDigest = 'sha256:other';
    if (invalid === 'provenance') h.options.provenance.resolve = async () => 'fixture:impostor';
    if (invalid === 'ambiguous') h.state.instances.push({ ...h.instance, pluginInstanceId: 'pi_other' });
    await assert.rejects(h.proof.prepare([input]), ProofAdmissionUnavailable);
    assert.equal(h.calls.length, 0);
  });
}

for (const result of [
  null,
  { covered: true },
  { covered: true, triggerCommentId: 43, observedAt: 10 },
  { covered: true, triggerCommentId: 42, observedAt: Infinity },
  { covered: false, triggerCommentId: 42, observedAt: 1, reason: 'invented' },
]) {
  test(`strict decoder rejects ${JSON.stringify(result)}`, async () => {
    const h = await proofFixture(async () => result);
    await assert.rejects(h.proof.prepare([input]), ProofAdmissionUnavailable);
  });
}

test('valid uncovered has no admission capability; duplicate inputs query once', async () => {
  const h = await proofFixture(async () => ({
    covered: false,
    reason: 'review_not_accepted',
    triggerCommentId: 42,
    observedAt: 1,
  }));
  assert.deepEqual(await h.proof.prepare([input]), { covered: false, reason: 'review_not_accepted' });
  const covered = await proofFixture();
  const prepared = await covered.proof.prepare([input, input]);
  assert.equal(covered.calls.length, 1);
  assert.equal(await prepared.admit(async () => 'written'), 'written');
  await assert.rejects(
    prepared.admit(async () => assert.fail('must not write twice')),
    ProofAdmissionUnavailable,
  );
});

for (const change of ['policy-aba', 'grants-aba', 'lifecycle', 'stop-start', 'runtime-recovery']) {
  test(`invalidation ${change} between query and first mutation rejects without writes`, async () => {
    const h = await proofFixture();
    const prepared = await h.proof.prepare([input]);
    const revision = h.instance.lifecycleRevision;
    if (change === 'stop-start' || change === 'runtime-recovery') {
      await h.carrier.stop('pi_proof');
      await h.carrier.start('pi_proof');
      assert.equal(h.instance.lifecycleRevision, revision);
    } else {
      await h.section.invalidate(async () => {
        if (change === 'policy-aba') {
          h.policy.revision += 1;
          h.policy.entries = [...h.policy.entries];
        }
        if (change === 'grants-aba') h.grant.grantRevision += 2;
        if (change === 'lifecycle') h.instance.lifecycleRevision += 1;
      });
    }
    let writes = 0;
    await assert.rejects(
      prepared.admit(async () => {
        writes += 1;
      }),
      ProofAdmissionUnavailable,
    );
    assert.equal(writes, 0);
  });
}

test('query in flight does not block stop; late result cannot write', async () => {
  const reply = deferred(),
    entered = deferred();
  const h = await proofFixture(async () => {
    entered.resolve();
    return reply.promise;
  });
  const pending = h.proof.prepare([input]);
  await entered.promise;
  await h.carrier.stop('pi_proof');
  reply.resolve({ covered: true, triggerCommentId: 42, observedAt: 1 });
  const prepared = await pending;
  await assert.rejects(
    prepared.admit(async () => assert.fail('stale write')),
    ProofAdmissionUnavailable,
  );
});

test('admission winner finishes create through CAS before queued stop cleanup', async () => {
  const h = await proofFixture();
  const prepared = await h.proof.prepare([input]);
  const entered = deferred(),
    finish = deferred();
  const events = [];
  const writing = prepared.admit(async () => {
    events.push('create');
    entered.resolve();
    await finish.promise;
    events.push('cas');
    return 200;
  });
  await entered.promise;
  const stopped = h.carrier.stop('pi_proof').then(() => events.push('stopped'));
  await Promise.resolve();
  assert.deepEqual(events, ['create']);
  finish.resolve();
  assert.equal(await writing, 200);
  await stopped;
  assert.deepEqual(events, ['create', 'cas', 'stopped']);
});

test('cleanup failure keeps closed pending and invalid activation until successful retry', async () => {
  let fail = true;
  const h = fixture({
    stop: async () => {
      if (fail) throw Error('cleanup');
    },
  });
  const started = await h.carrier.start('pi_proof');
  const token = h.carrier.captureProofActivation('pi_proof');
  let closed = false;
  started.closed.then(() => {
    closed = true;
  });
  await assert.rejects(h.carrier.stop('pi_proof'), /cleanup/);
  assert.equal(token.isCurrent(), false);
  assert.equal(closed, false);
  fail = false;
  await h.carrier.stop('pi_proof');
  await started.closed;
});

test('stop during startup cannot publish a ready proof activation', async () => {
  const starting = deferred(),
    entered = deferred();
  const h = fixture({
    start: async () => {
      entered.resolve();
      await starting.promise;
    },
    stop: async () => {},
  });
  const start = h.carrier.start('pi_proof');
  await entered.promise;
  assert.throws(() => h.carrier.captureProofActivation('pi_proof'));
  const rejected = assert.rejects(start, /cancelled/);
  const stopping = h.carrier.stop('pi_proof');
  starting.resolve();
  await Promise.all([stopping, rejected]);
  assert.throws(() => h.carrier.captureProofActivation('pi_proof'));
});

test('failed start plus failed cleanup retains invalid ownership until stop retry', async () => {
  let cleanupFails = true;
  const h = fixture({
    start: async () => {
      throw Error('start');
    },
    stop: async () => {
      if (cleanupFails) throw Error('cleanup');
    },
  });
  await assert.rejects(h.carrier.start('pi_proof'), AggregateError);
  assert.throws(() => h.carrier.captureProofActivation('pi_proof'));
  await assert.rejects(h.carrier.start('pi_proof'), /runtime owner/);
  cleanupFails = false;
  await h.carrier.stop('pi_proof');
});

for (const scenario of [
  'success',
  'uncovered',
  'bad-result',
  'invalid-before-create',
  'cas-conflict',
  'unauthenticated',
]) {
  test(`actual callback admission: ${scenario}`, async (t) => {
    const { default: Fastify } = await import('fastify');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const h = await proofFixture(async () =>
      scenario === 'bad-result'
        ? { covered: true }
        : {
            covered: scenario !== 'uncovered',
            ...(scenario === 'uncovered' ? { reason: 'review_not_accepted' } : {}),
            triggerCommentId: 42,
            observedAt: 10,
          },
    );
    const registry = new InvocationRegistry(),
      taskStore = new TaskStore(),
      threadStore = new ThreadStore();
    const thread = threadStore.create('fixture-user', 'proof callback');
    const auth = await registry.create('fixture-user', 'opus', thread.id);
    const writes = { create: 0, cas: 0, grant: 0, legacyQuery: 0 };
    const create = taskStore.create.bind(taskStore),
      replace = taskStore.replaceAutomationStateIfGeneration.bind(taskStore);
    taskStore.create = (...args) => {
      writes.create++;
      return create(...args);
    };
    taskStore.replaceAutomationStateIfGeneration = (...args) => {
      writes.cas++;
      return scenario === 'cas-conflict' ? null : replace(...args);
    };
    const app = Fastify();
    t.after(() => app.close());
    await app.register(callbacksRoutes, {
      registry,
      taskStore,
      threadStore,
      messageStore: new MessageStore(),
      socketManager: {
        broadcastAgentMessage() {},
        broadcastToRoom() {},
        getMessages() {
          return [];
        },
      },
      evidenceStore: { search: async () => [], health: async () => true },
      reflectionService: { reflect: async () => '' },
      markerQueue: { list: async () => [] },
      fetchPrWaitBaseline: async () => ({ baseline: { capturedAt: 1, headSha: 'head' }, collectorState: {} }),
      verifyPrReviewEventWaitCoverage: async () => {
        writes.legacyQuery++;
        throw Error('must never query legacy with admitted seam');
      },
      reviewProofAdmission: {
        prepare: async (inputs) => {
          const prepared = await h.proof.prepare(inputs);
          if (scenario === 'invalid-before-create')
            await h.section.invalidate(async () => {
              writes.grant++;
              h.grant.grantRevision++;
            });
          return prepared;
        },
      },
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/callbacks/register-pr-tracking',
      headers:
        scenario === 'unauthenticated'
          ? {}
          : { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        ...input,
        triggerCommentId: undefined,
        when: [{ kind: 'pr_review_result_available', triggerCommentId: 42 }],
        nextStep: 'Re-lock HEAD and continue.',
        expiresAt: Date.now() + 60_000,
      },
    });
    assert.equal(
      result.statusCode,
      {
        success: 200,
        uncovered: 422,
        'bad-result': 503,
        'invalid-before-create': 503,
        'cas-conflict': 409,
        unauthenticated: 401,
      }[scenario],
      result.body,
    );
    const writesAllowed = scenario === 'success' || scenario === 'cas-conflict';
    assert.equal(writes.create, writesAllowed ? 1 : 0);
    assert.equal(writes.cas, writesAllowed ? 1 : 0);
    assert.equal(
      writes.grant,
      scenario === 'invalid-before-create' ? 1 : 0,
      'only the explicit revocation writer may change grants',
    );
    assert.equal(writes.legacyQuery, 0);
    assert.equal(h.calls.length, scenario === 'unauthenticated' ? 0 : 1);
  });
}

test('stop cleanup cannot complete while startup may still allocate resources', async () => {
  const starting = deferred(),
    entered = deferred();
  let resourceLive = false;
  const h = fixture({
    start: async () => {
      entered.resolve();
      await starting.promise;
      resourceLive = true;
    },
    stop: async () => {
      resourceLive = false;
    },
  });
  const start = h.carrier.start('pi_proof');
  const rejected = assert.rejects(start, /cancelled/);
  await entered.promise;
  let done = false;
  const stop = h.carrier.stop('pi_proof').then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = done;
  starting.resolve();
  await Promise.all([stop, rejected]);
  assert.equal(premature, false, 'stop completion must join startup');
  assert.equal(resourceLive, false, 'late startup allocations are cleaned before stop resolves');
});

test('revocation during async validation rejects before the first mutation', async () => {
  const section = new ProcessLocalProofAdmissionSection();
  const checking = deferred(),
    finish = deferred();
  let writes = 0;
  const attempt = section.admit(
    section.revision(),
    async () => {
      checking.resolve();
      await finish.promise;
      return true;
    },
    async () => {
      writes++;
    },
  );
  const rejected = assert.rejects(attempt, ProofAdmissionUnavailable);
  await checking.promise;
  const revoked = section.invalidate(async () => {});
  finish.resolve();
  await Promise.all([rejected, revoked]);
  assert.equal(writes, 0);
});

test('transport failure and extra authority fields cannot produce admission', async () => {
  const failed = await proofFixture(async () => {
    throw Error('provider unavailable');
  });
  await assert.rejects(failed.proof.prepare([input]), ProofAdmissionUnavailable);
  const forged = await proofFixture(async () => ({
    covered: true,
    triggerCommentId: 42,
    observedAt: 10,
    authorized: true,
  }));
  await assert.rejects(forged.proof.prepare([input]), ProofAdmissionUnavailable);
});
