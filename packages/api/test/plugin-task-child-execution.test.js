import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

let auditDir;
let previousAuditDir;
before(async () => {
  previousAuditDir = process.env.AUDIT_LOG_DIR;
  auditDir = await mkdtemp(join(tmpdir(), 'task-child-execution-'));
  process.env.AUDIT_LOG_DIR = auditDir;
});
after(async () => {
  if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = previousAuditDir;
  await rm(auditDir, { recursive: true, force: true });
});

function fixture(t) {
  const turns = new InMemoryTurnExecutionStore();
  const state = { reads: [], events: [], starts: 0, closes: 0, disposals: 0, exposures: 0, current: true };
  const registry = new InvocationRegistry({
    turnExecutionStore: turns,
    assertPluginTaskCurrent: async (input) => {
      state.checks = (state.checks ?? 0) + 1;
      assert.equal(input.pluginTaskBinding.taskId, 'task-1');
      if (!state.current) throw Error('task_authority_revoked');
    },
  });
  const controller = new AbortController();
  const taskBinding = {
    version: 1,
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: 'task-1',
    taskRevision: 1,
    targetCatId: 'codex',
    threadId: 'thread',
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceMessageId: 'original-source',
    sourceRevision: 1,
    triggerMessageId: 'source-1',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
  };
  const forbidden = (name) => () => {
    state.reads.push(name);
    throw new Error('forbidden_owner_context_read');
  };
  const launch = {
    server: {
      name: 'native',
      command: '/fake/package',
      args: [],
      env: {},
      workingDirectory: '/fake/package-root',
      transport: 'stdio',
    },
    sandbox: {
      kind: 'entrusted_work',
      workspaceRoot: '/fake/task-workspace',
      runtimeSkillsRoot: '/fake/skills',
      taskBinding,
    },
    async assertCurrent() {
      state.events.push('current');
      controller.signal.throwIfAborted();
      if (!state.current) throw new Error('task_authority_revoked');
    },
  };
  const prepared = {
    source: { messageId: 'source-1', content: 'private Task prompt' },
    launch,
    async dispose() {
      state.disposals++;
      state.events.push('dispose');
    },
  };
  const port = {
    async prepare(input) {
      state.events.push('prepare');
      state.prepareInput = input;
      await launch.assertCurrent();
      return prepared;
    },
  };
  const params = {
    catId: 'codex',
    userId: 'owner',
    threadId: 'thread',
    ownerAuthProvenance: 'unknown',
    prompt: 'private Task prompt',
    isLastCat: true,
    signal: controller.signal,
    executionCausal: { triggerMessageId: 'source-1' },
    promptMessageIds: ['source-1'],
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'native',
      actionMethods: ['native.read'],
    },
    pluginTaskBinding: taskBinding,
    pluginTaskExecution: port,
    async onPromptMessagesExposed(input) {
      state.exposures++;
      state.events.push('exposure');
      state.exposureInput = input;
    },
    service: {
      supportsToolExecutionPolicy: () => false,
      supportsPluginTaskLaunch: () => true,
      async *invoke(prompt, options) {
        state.starts++;
        state.events.push('provider');
        state.prompt = prompt;
        state.options = options;
        try {
          yield { type: 'text', catId: 'codex', content: 'private result', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } finally {
          state.closes++;
        }
      },
    },
  };
  const deps = {
    registry,
    turnExecutionStore: turns,
    apiUrl: 'http://127.0.0.1:1',
    sessionManager: {
      get: forbidden('session'),
      getOrCreate: forbidden('session-create'),
      resolveWorkingDirectory: forbidden('workspace'),
    },
    threadStore: { get: forbidden('thread') },
    workflowSopStore: { bindManagedWorkAttempt: forbidden('work') },
    profileCueOpportunitySource: { prepareOpportunity: forbidden('profile') },
    eventCueOpportunitySource: { prepareOpportunity: forbidden('memory') },
  };
  const iterator = invokeSingleCat(deps, params)[Symbol.asyncIterator]();
  t.after(async () => {
    await iterator.return();
  });
  return { state, params, registry, turns, iterator, controller, port, launch, prepared, deps };
}
async function created(f) {
  const first = await f.iterator.next();
  assert.equal(first.done, false);
  const child = JSON.parse(first.value.content);
  assert.equal(child.type, 'invocation_created');
  assert.equal((await f.turns.get(child.invocationId)).status, 'running');
  assert.equal((await f.registry.getRecord(child.invocationId)).pluginTaskBinding.taskId, 'task-1');
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.exposures, 0);
  assert.deepEqual(f.state.reads, []);
  f.childId = child.invocationId;
}
async function drain(f) {
  const messages = [];
  for (;;) {
    const next = await f.iterator.next();
    if (next.done) return messages;
    messages.push(next.value);
  }
}
function isolated(f) {
  assert.deepEqual(f.state.reads, [], 'missing isolated public child execution');
}
async function terminal(f, status) {
  assert.equal((await f.turns.get(f.childId)).status, status);
  assert.notEqual((await f.registry.getRecord(f.childId)).state, 'active');
}

test('Task child registers durable identity and executes once without owner context', async (t) => {
  const f = fixture(t);
  f.params.prompt = 'OWNER PRIVATE HISTORY';
  await created(f);
  await drain(f);
  isolated(f);
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.exposures, 1);
  assert.equal(f.state.disposals, 1);
  assert.equal(f.state.prompt, 'private Task prompt');
  assert.ok(f.state.checks > 2);
  assert.deepEqual(f.state.options.pluginNativeLaunch.sandbox.taskBinding, f.params.pluginTaskBinding);
  assert.equal(f.state.options.callbackEnv.CAT_CAFE_INVOCATION_ID, f.childId);
  for (const k of ['sessionId', 'systemPrompt', 'contentBlocks', 'continuity', 'liveCompanion', 'requiredTools'])
    assert.equal(f.state.options[k], undefined);
  await terminal(f, 'succeeded');
});
test('Task registration captures binding policy and prepare function before await', async (t) => {
  const f = fixture(t);
  const pending = created(f);
  f.params.pluginTaskBinding.taskId = 'foreign';
  f.params.toolExecutionPolicy.actionMethods.push('admin');
  f.port.prepare = () => {
    throw Error('replaced');
  };
  await pending;
  const record = await f.registry.getRecord(f.childId);
  assert.equal(record.pluginTaskBinding.taskId, 'task-1');
  assert.deepEqual(record.toolExecutionPolicy.actionMethods, ['native.read']);
  // The mutable launch is independently checked against the captured registration binding.
  await drain(f);
  assert.equal(f.state.starts, 0);
  await terminal(f, 'failed');
});
test('Task child early return terminalizes credentials and canonical turn', async (t) => {
  const f = fixture(t);
  await created(f);
  const r = await f.registry.getRecord(f.childId);
  await f.iterator.return();
  assert.equal((await f.registry.verifyLatest(f.childId, r.callbackToken)).ok, false);
  await terminal(f, 'interrupted');
});
for (const [name, change] of [
  ['missing launch', (f) => delete f.params.pluginTaskExecution],
  ['public sandbox', (f) => (f.launch.sandbox = { kind: 'public', workspaceRoot: '/fake/public' })],
  [
    'foreign binding',
    (f) =>
      (f.launch.sandbox = {
        ...f.launch.sandbox,
        taskBinding: { ...f.params.pluginTaskBinding, executionRef: 'message:other' },
      }),
  ],
  ['missing exposure', (f) => delete f.params.onPromptMessagesExposed],
])
  test(`Task child refuses ${name} without ordinary fallback`, async (t) => {
    const f = fixture(t);
    change(f);
    await created(f);
    await drain(f);
    assert.equal(f.state.starts, 0);
    assert.equal(f.state.exposures, 0);
    isolated(f);
    await terminal(f, 'failed');
  });
for (const [name, change] of [
  ['owner history', (f) => (f.params.systemPrompt = 'owner rules')],
  ['foreign principal', (f) => (f.params.pluginTaskBinding.ownerUserId = 'foreign')],
  ['public port', (f) => (f.params.publicInvocationExecution = f.port)],
  ['unsupported provider', (f) => (f.params.service.supportsPluginTaskLaunch = () => false)],
  ['unbound port', (f) => delete f.params.pluginTaskBinding],
])
  test(`Task registration rejects ${name} before provider or owner reads`, async (t) => {
    const f = fixture(t);
    change(f);
    await assert.rejects(() => f.iterator.next());
    assert.equal(f.state.starts, 0);
    isolated(f);
  });
test('Task Registry revocation blocks launch even when launch callback permits it', async (t) => {
  const f = fixture(t);
  await created(f);
  f.launch.assertCurrent = async () => {};
  f.state.current = false;
  await drain(f);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.exposures, 0);
  await terminal(f, 'failed');
});
test('Task revoked while provider yields cannot emit text or success', async (t) => {
  const f = fixture(t);
  f.launch.assertCurrent = async () => {};
  f.params.service.invoke = async function* () {
    f.state.starts++;
    try {
      f.state.current = false;
      yield { type: 'text', catId: 'codex', content: 'hidden', timestamp: Date.now() };
    } finally {
      f.state.closes++;
    }
  };
  await created(f);
  const events = await drain(f);
  assert.equal(
    events.some((e) => e.type === 'text'),
    false,
  );
  assert.equal(f.state.closes, 1);
  await terminal(f, 'failed');
});
test('Task stale child still running loses latest authority before provider start', async (t) => {
  const f = fixture(t);
  await created(f);
  await f.registry.create('owner', 'codex', 'thread');
  await drain(f);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.exposures, 0);
  await terminal(f, 'failed');
});
test('actual Codex grants Task launch capability only to exec_json, not ordinary plugin policy', async () => {
  const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
  for (const carrierMode of ['exec_json', 'app_server']) {
    const service = new CodexAgentService({ catId: 'codex', carrierMode });
    assert.equal(service.supportsPluginTaskLaunch?.(), carrierMode === 'exec_json');
    assert.equal(
      service.supportsToolExecutionPolicy({
        mode: 'plugin_native',
        pluginInstanceId: 'instance',
        contributionId: 'native',
        actionMethods: ['native.read'],
      }),
      false,
    );
  }
});

test('Task currentness failure stays poisoned if provider catches it and authority returns', async (t) => {
  const f = fixture(t);
  f.params.service.invoke = async function* (_prompt, options) {
    f.state.starts++;
    f.state.current = false;
    await assert.rejects(options.pluginNativeLaunch.assertCurrent);
    f.state.current = true;
    yield { type: 'text', catId: 'codex', content: 'must stay hidden', timestamp: Date.now() };
  };
  await created(f);
  const events = await drain(f);
  assert.equal(
    events.some((e) => e.type === 'text'),
    false,
  );
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});
test('Task execution cannot launch when Registry has no Host currentness reader', async (t) => {
  const f = fixture(t);
  const registry = new InvocationRegistry({ turnExecutionStore: f.turns });
  f.deps.registry = registry;
  f.registry = registry;
  await created(f);
  await drain(f);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.exposures, 0);
  await terminal(f, 'failed');
});
test('Task captures callable before registration and closes provider on early return', async (t) => {
  const f = fixture(t);
  const pending = created(f);
  f.port.prepare = () => {
    throw Error('must not use replacement');
  };
  await pending;
  const first = await f.iterator.next();
  assert.equal(first.value.type, 'text');
  await f.iterator.return();
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.closes, 1);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'interrupted');
  await assert.rejects(f.state.options.pluginNativeLaunch.assertCurrent);
});
test('Task revocation during exposure is rechecked before invoking provider', async (t) => {
  const f = fixture(t);
  f.launch.assertCurrent = async () => {};
  f.params.onPromptMessagesExposed = async () => {
    f.state.exposures++;
    f.state.current = false;
  };
  await created(f);
  await drain(f);
  assert.equal(f.state.exposures, 1);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.disposals, 1);
  await terminal(f, 'failed');
});
test('generic plugin policy support cannot grant the Task execution capability', async (t) => {
  const f = fixture(t);
  f.params.service.supportsToolExecutionPolicy = () => true;
  delete f.params.service.supportsPluginTaskLaunch;
  await assert.rejects(() => f.iterator.next(), /task_execution_carrier/);
  assert.equal(f.state.starts, 0);
  isolated(f);
});
