import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.ts';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.ts';
import {
  withPluginOwnerRequest,
  withPluginOwnerWebhook,
} from '../src/domains/plugin/carrier/plugin-owner-request-context.ts';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/plugin-task-host.ts';

async function fixture(grants = ['task.admitEntrusted']) {
  const messages = new MessageStore();
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const thread = await threads.create('owner', 'Admission');
  threads.addParticipants(thread.id, ['codex']);
  const source = messages.append({
    userId: 'owner',
    threadId: thread.id,
    catId: null,
    content: 'Please produce the report.',
    mentions: [],
    timestamp: 1,
    source: { connector: 'neutral', label: 'Neutral', icon: 'message' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  let active = true;
  const deps = {
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: grants,
    taskStore: tasks,
    threadStore: threads,
    readThreadStore: threads,
    assertCurrent: async () => {
      assert.ok(active, 'activation expired');
    },
    admission: {
      messageStore: messages,
      isCatAvailable: (id) => id === 'codex',
      assertCurrent: async () => {
        assert.ok(active, 'admission grant expired');
      },
    },
  };
  const host = createPluginTaskHost(deps);
  assert.equal(typeof host.prepareEntrusted, 'function', 'Task Host must expose actual entrusted admission');
  const input = {
    sourceMessageId: source.id,
    targetCatId: 'codex',
    destination: { kind: 'derived_from_source' },
    subject: {
      kind: 'new',
      title: 'Report',
      intendedOutcome: 'A report',
      closure: { condition: 'Report accepted', expectedSignal: 'accepted' },
    },
  };
  const owner = (operation, run) =>
    withPluginOwnerRequest(
      {
        pluginId: 'neutral',
        contributionId: 'owner',
        userId: 'owner',
        operation,
        signal: new AbortController().signal,
        requestIdentity: {
          requestId: randomUUID(),
          transportRequestId: 'transport',
          method: 'POST',
          declaredPath: 'owner',
          path: 'owner',
          bodyDigest: 'a'.repeat(64),
          queryDigest: 'b'.repeat(64),
        },
      },
      () => withPluginOwnerWebhook('neutral', 'owner', 'instance', false, () => {}, run),
    );
  return {
    messages,
    tasks,
    threads,
    thread,
    source,
    deps,
    host,
    input,
    owner,
    expire: () => {
      active = false;
    },
  };
}

const data = (f, ref) => JSON.parse(f.messages.getById(ref.slice(8)).content.split('\n').slice(1).join('\n'));
const continuation = (f, first) => ({
  ...(f.prepareInput ?? f.input),
  subject: { kind: 'continue', taskRef: first.taskRef, expectedRevision: first.taskRevision },
});

test('v2 initial receipt freezes Host provenance and authority epoch', async () => {
  const f = await fixture();
  const first = await f.owner('write', () => f.host.prepareEntrusted(f.input));
  const execution = data(f, first.executionRef);
  assert.equal(execution.version, 2);
  assert.equal(execution.executionAuthorityRevision, 1);
  assert.equal(execution.executionKind, 'initial');
  assert.equal(execution.firstAdmission.kind, 'owner_http_write');
  assert.ok(execution.firstAdmission.request.requestId);
  assert.equal(execution.businessBasis, undefined);
});
test('v2 exact owner retry reuses execution; distinct owner request resumes same source independently', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  const input = continuation(f, first);
  let a, retry;
  await f.owner('write', async () => {
    a = await f.host.prepareEntrusted(input);
    retry = await f.host.prepareEntrusted(input);
  });
  const b = await f.owner('write', () => f.host.prepareEntrusted(input));
  assert.equal(a.executionRef, retry.executionRef);
  assert.notEqual(a.executionRef, b.executionRef);
  assert.equal(a.taskRef, first.taskRef);
  assert.equal(a.taskRevision, first.taskRevision);
  assert.equal(data(f, a.executionRef).executionKind, 'owner_resume');
  assert.equal(data(f, a.executionRef).firstAdmission.kind, 'installed_plugin_policy');
  assert.equal(data(f, a.executionRef).request.kind, 'owner_http_write');
});
test('v2 one owner request cannot switch source after its first preparation', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  const input = continuation(f, first);
  const other = f.messages.append({ ...structuredClone(f.source), content: 'other', timestamp: 2 });
  await f.owner('write', async () => {
    await f.host.prepareEntrusted(input);
    await assert.rejects(() => f.host.prepareEntrusted({ ...input, sourceMessageId: other.id }), /request.*conflict/i);
  });
});
test('v2 initial replay preserves first provenance through a different caller', async () => {
  const f = await fixture();
  const first = await f.owner('write', () => f.host.prepareEntrusted(f.input));
  const next = await f.host.prepareEntrusted(f.input);
  assert.equal(first.executionRef, next.executionRef);
  assert.equal(data(f, next.executionRef).firstAdmission.kind, 'owner_http_write');
});
test('v2 background cannot use first source as manual resume', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  await assert.rejects(() => f.host.prepareEntrusted(continuation(f, first)));
  assert.equal(data(f, first.executionRef).version, 2);
});
test('v2 continuation retains exact aggregate precondition', async () => {
  const f = await fixture();
  const first = await f.host.prepareEntrusted(f.input);
  const task = f.tasks.get(first.taskRef.slice(10));
  task.entrustedWork.revision++;
  await assert.rejects(() => f.owner('write', () => f.host.prepareEntrusted(continuation(f, first))));
  assert.equal(data(f, first.executionRef).version, 2);
});

async function executionFixture(backend) {
  const f = await fixture();
  const { InvocationQueue } = await import('../src/domains/cats/services/agents/invocation/InvocationQueue.ts');
  const { InvocationRegistry } = await import('../src/domains/cats/services/agents/invocation/InvocationRegistry.ts');
  const { createPluginTaskDispatchAuthority, createPluginTaskQueueAuthority, createPluginTaskInvocationCurrentness } =
    await import('../src/domains/plugin/host-surface/plugin-task-currentness.ts');
  const state = {
    instances: [
      {
        pluginInstanceId: 'instance',
        pluginId: 'neutral',
        packageDigest: 'digest',
        lifecycleRevision: 3,
        lifecycleState: 'installed',
        activationState: 'enabled',
        configReadiness: 'ready',
        runtimeState: 'healthy',
      },
    ],
    packages: [{ packageDigest: 'digest', pluginId: 'neutral', packageState: 'installed' }],
    grants: [{ pluginInstanceId: 'instance', grantRevision: 2, effectiveGrants: ['task.admitEntrusted'] }],
  };
  const deps = {
    ownerUserId: 'owner',
    taskStore: f.tasks,
    messageStore: f.messages,
    threadStore: f.threads,
    inventory: { snapshot: async () => state },
    isCatAvailable: () => true,
  };
  const authority = createPluginTaskDispatchAuthority(deps, 'instance'),
    queue = new InvocationQueue(),
    resumes = [];
  const host = createPluginTaskHost({
    ...f.deps,
    dispatch: {
      messageStore: f.messages,
      queue,
      readAuthority: authority.read,
      resume: async (...v) => resumes.push(v),
    },
  });
  const first = await host.prepareEntrusted(f.input);
  const selection = { taskRef: first.taskRef, taskRevision: first.taskRevision, executionRef: first.executionRef };
  const result = await host.dispatchEntrusted(selection);
  const input = {
    messageId: result.messageRef.slice(8),
    entryId: result.entryId,
    userId: 'owner',
    threadId: first.threadId,
    targetCatId: 'codex',
  };
  const queueAuthority = createPluginTaskQueueAuthority(deps),
    binding = await queueAuthority.read(input),
    check = createPluginTaskInvocationCurrentness(deps);
  // Turn liveness is an explicit fixture; Message/Task/Queue custody and Registry are real implementations.
  const registry = new InvocationRegistry({
    ...(backend ? { backend } : {}),
    turnExecutionStore: { get: async () => ({ status: 'running' }) },
    assertPluginTaskCurrent: check,
  });
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'instance',
    contributionId: 'private',
    actionMethods: ['work.read'],
  };
  const creds = await registry.create(
    'owner',
    'codex',
    first.threadId,
    undefined,
    undefined,
    policy,
    input.messageId,
    'unknown',
    undefined,
    undefined,
    binding,
  );
  await queueAuthority.bindChild({ ...input, binding, invocationId: creds.invocationId });
  const record = await registry.getRecord(creds.invocationId);
  return {
    ...f,
    prepareInput: f.input,
    host,
    first,
    selection,
    authority,
    queue,
    queueAuthority,
    state,
    input,
    binding,
    check,
    registry,
    creds,
    record,
    resumes,
    task: f.tasks.get(first.taskRef.slice(10)),
  };
}
test('v2 passes actual dispatch, Queue read/child CAS and Registry currentness', async () => {
  const f = await executionFixture();
  assert.equal(f.binding.version, 2);
  assert.equal(f.binding.executionAuthorityRevision, 1);
  assert.match(f.binding.executionReceiptDigest, /^[a-f0-9]{64}$/);
  assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, true);
  await assert.rejects(() => f.queueAuthority.bindChild({ ...f.input, binding: f.binding, invocationId: 'second' }));
});
test('v2 evidence-only projection does not relax ordinary artifact mutation or continuation expected revision', async () => {
  const f = await executionFixture();
  // Task-owner CAS is real; upstream publication verification remains a declared fixture, not a Service receipt.
  const attached = f.tasks.attachEntrustedWorkArtifactEvidence(f.task.id, {
    expectedRevision: 1,
    executionAuthorityRevision: f.binding.executionAuthorityRevision,
    ownerUserId: f.binding.ownerUserId,
    ownerCatId: f.binding.targetCatId,
    threadId: f.binding.threadId,
    admissionRef: f.binding.admissionRef,
    artifactRef: 'artifact:fixture',
  });
  assert.equal(attached.kind, 'attached');
  await f.check(f.record);
  assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, true);
  await assert.rejects(() => f.owner('write', () => f.host.prepareEntrusted(continuation(f, f.first))));
  assert.equal(
    f.tasks.updateEntrustedWork(f.task.id, { expectedRevision: 2, artifactRefs: ['artifact:ordinary'] }).kind,
    'updated',
  );
  await assert.rejects(() => f.check(f.record));
});
for (const [name, mutate] of [
  ['epoch', (f) => f.task.entrustedWork.executionAuthorityRevision++],
  ['missing epoch', (f) => delete f.task.entrustedWork.executionAuthorityRevision],
  ['source', (f) => f.source.extra.pluginMessage.revision++],
  ['grant', (f) => f.state.grants[0].grantRevision++],
  ['owner', (f) => (f.task.userId = 'other')],
  ['closure', (f) => (f.task.entrustedWork.closure.state = 'completed')],
  ['receipt', (f) => (f.messages.getById(f.first.executionRef.slice(8)).content += ' ')],
])
  test(`v2 Registry permanently revokes on ${name}`, async () => {
    const f = await executionFixture();
    mutate(f);
    assert.deepEqual(await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken), {
      ok: false,
      reason: 'revoked',
    });
  });
test('v2 native opt-in exposes protected phase/provenance without business basis or request body', async () => {
  const f = await executionFixture();
  const { createPluginSourceFactsHost } = await import(
    '../src/domains/plugin/host-surface/plugin-source-facts-host.ts'
  );
  const { captureNativeCallbackCurrentness } = await import('../src/routes/plugin-native-action-currentness.ts');
  const fence = captureNativeCallbackCurrentness(
    f.record,
    f.creds.callbackToken,
    { instanceId: 'instance', contributionId: 'private', method: 'work.read' },
    { registry: f.registry, threadStore: f.threads },
  );
  const native = createPluginSourceFactsHost({
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: f.messages,
    threadStore: f.threads,
    assertCurrent: async () => {},
  }).nativeContext;
  const result = await withPluginCallContext(
    'instance',
    {
      ...fence.identity,
      assertCurrent: fence.assertCurrent,
      assertInvocationCurrent: fence.assertInvocationCurrent,
      readTaskBinding: fence.readTaskBinding,
    },
    () => native.current({ includeTask: true }),
  );
  assert.deepEqual(result.task.execution, {
    kind: 'initial',
    firstAdmissionKind: 'installed_plugin_policy',
    requestKind: 'installed_plugin_policy',
  });
  assert.equal(result.task.businessBasis, undefined);
  assert.equal(result.task.request, undefined);
});
test('v2 manual resume cannot be dispatched from background or another owner request', async () => {
  const f = await executionFixture();
  let selected;
  await f.owner('write', async () => {
    const v = await f.host.prepareEntrusted(continuation(f, f.first));
    selected = { taskRef: v.taskRef, taskRevision: v.taskRevision, executionRef: v.executionRef };
    assert.equal((await f.host.dispatchEntrusted(selected)).status, 'queued');
  });
  await assert.rejects(() => f.host.dispatchEntrusted(selected));
  await assert.rejects(() => f.owner('write', () => f.host.dispatchEntrusted(selected)));
});
test('v2 Redis identity codec preserves version and refuses partial or downgraded binding', async () => {
  const f = await executionFixture();
  const { RedisAuthInvocationBackend } = await import(
    '../src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts'
  );
  const { authRecordFromRedisHash } = await import(
    '../src/domains/cats/services/agents/invocation/RedisAuthInvocationRecord.ts'
  );
  let fields;
  const redis = {
    get: async () => null,
    eval: async (_s, _n, ...args) => {
      fields = Object.fromEntries(
        Array.from({ length: (args.length - 8) / 2 }, (_, i) => [args[8 + i * 2], args[9 + i * 2]]),
      );
      return ['ok', ''];
    },
  };
  await new RedisAuthInvocationBackend(redis).create({ ...f.record, clientMessageIds: new Set() });
  assert.equal(fields.pluginTaskBindingVersion, '2');
  const restored = authRecordFromRedisHash(fields, new Set());
  assert.deepEqual(restored.pluginTaskBinding, f.binding);
  for (const change of [
    (v) => delete v.executionAuthorityRevision,
    (v) => delete v.executionReceiptDigest,
    (v) => (v.version = 1),
    (v) => (v.executionAuthorityRevision = 0),
    (v) => (v.executionReceiptDigest = 'invalid'),
  ]) {
    const value = JSON.parse(fields.pluginTaskBinding);
    change(value);
    assert.equal(authRecordFromRedisHash({ ...fields, pluginTaskBinding: JSON.stringify(value) }, new Set()), null);
  }
  assert.equal(authRecordFromRedisHash({ ...fields, pluginTaskBindingVersion: '1' }, new Set()), null);
});

test(
  'v2 isolated Redis retains epoch identity and revocation across Registry replacement',
  { skip: process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1' },
  async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { assertRedisIsolationOrThrow } = await import('./helpers/redis-test-helpers.js');
    const { RedisAuthInvocationBackend } = await import(
      '../src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts'
    );
    const { InvocationRegistry } = await import('../src/domains/cats/services/agents/invocation/InvocationRegistry.ts');
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'plugin-task-execution-v2');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `task-v2-${randomUUID()}:` });
    try {
      const f = await executionFixture(new RedisAuthInvocationBackend(redis));
      const restore = () =>
        new InvocationRegistry({
          backend: new RedisAuthInvocationBackend(redis),
          turnExecutionStore: { get: async () => ({ status: 'running' }) },
          assertPluginTaskCurrent: f.check,
        });
      const fresh = restore();
      const result = await fresh.verifyLatest(f.creds.invocationId, f.creds.callbackToken);
      assert.equal(result.ok, true);
      assert.deepEqual(result.record.pluginTaskBinding, f.binding);
      assert.equal(await redis.ttl(`auth:inv:${f.creds.invocationId}`), -1);
      assert.equal(await redis.hget(`auth:inv:${f.creds.invocationId}`, 'pluginTaskBindingVersion'), '2');
      f.tasks.updateEntrustedWork(f.task.id, { expectedRevision: 1, artifactRefs: ['artifact:ordinary'] });
      assert.deepEqual(await fresh.verifyLatest(f.creds.invocationId, f.creds.callbackToken), {
        ok: false,
        reason: 'revoked',
      });
      assert.deepEqual(await restore().verifyLatest(f.creds.invocationId, f.creds.callbackToken), {
        ok: false,
        reason: 'revoked',
      });
    } finally {
      await redis.quit();
    }
  },
);

test('Task artifact production port uses real Queue/Registry binding and evidence attach preserves callback currentness', async () => {
  const f = await executionFixture();
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createPluginTaskArtifactHost } = await import(
    '../src/domains/plugin/host-surface/plugin-task-artifact-host.ts'
  );
  const { captureNativeCallbackCurrentness } = await import('../src/routes/plugin-native-action-currentness.ts');
  const fence = captureNativeCallbackCurrentness(
    f.record,
    f.creds.callbackToken,
    { instanceId: 'instance', contributionId: 'private', method: 'work.read' },
    { registry: f.registry, threadStore: f.threads },
  );
  const host = createPluginTaskArtifactHost({
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    messageStore: f.messages,
    taskStore: f.tasks,
    taskArtifactDirectory: await mkdtemp(join(tmpdir(), 'task-v2-artifact-')),
    assertCurrent: async () => {
      assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, true);
    },
  });
  const run = (fn) =>
    withPluginCallContext(
      'instance',
      {
        ...fence.identity,
        assertCurrent: fence.assertCurrent,
        assertInvocationCurrent: fence.assertInvocationCurrent,
        readTaskBinding: fence.readTaskBinding,
      },
      fn,
    );
  const result = await run(() => host.publishText({ text: '# Actual Task artifact', mediaType: 'text/markdown' }));
  assert.equal(result.seal.executionRef, f.first.executionRef);
  assert.equal(result.seal.invocationId, f.creds.invocationId);
  assert.equal(f.tasks.get(f.task.id).entrustedWork.revision, 2);
  assert.equal(f.tasks.get(f.task.id).entrustedWork.executionAuthorityRevision, 1);
  assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, true);
  assert.equal(
    (await run(() => host.readText({ publicationRef: result.publicationRef, artifactRef: result.artifactRef }))).text,
    '# Actual Task artifact',
  );
  await f.tasks.updateEntrustedWork(f.task.id, {
    expectedRevision: 2,
    artifactRefs: [result.artifactRef, 'artifact:ordinary-update'],
  });
  await assert.rejects(() =>
    run(() => host.readText({ publicationRef: result.publicationRef, artifactRef: result.artifactRef })),
  );
  assert.equal((await f.registry.verifyLatest(f.creds.invocationId, f.creds.callbackToken)).ok, false);
});
