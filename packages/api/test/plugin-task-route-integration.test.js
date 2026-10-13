import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CallbackAuthTurnExecutionLifecycle } from '../src/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.ts';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.ts';
import { routePublicInvocation } from '../src/domains/cats/services/agents/routing/route-public-invocation.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

let auditDir, previousAuditDir;
before(async () => {
  previousAuditDir = process.env.AUDIT_LOG_DIR;
  auditDir = await mkdtemp(join(tmpdir(), 'task-route-'));
  process.env.AUDIT_LOG_DIR = auditDir;
});
after(async () => {
  if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = previousAuditDir;
  await rm(auditDir, { recursive: true, force: true });
});

function fixture({ fail = false, silent = false } = {}) {
  const turns = new InMemoryTurnExecutionStore(),
    store = new MessageStore();
  const state = { ownerReads: [], starts: 0, disposals: 0, checks: 0, current: true };
  const binding = {
    version: 1,
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    taskId: 'task',
    taskRevision: 1,
    targetCatId: 'codex',
    threadId: 'thread',
    admissionRef: 'message:admission',
    executionRef: 'message:execution',
    sourceMessageId: 'original',
    sourceRevision: 1,
    triggerMessageId: 'trigger',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 1,
  };
  const registry = new InvocationRegistry({
    turnExecutionStore: turns,
    async assertPluginTaskCurrent(input) {
      state.checks++;
      assert.deepEqual(input.pluginTaskBinding, binding);
      if (!state.current) throw Error('task_revoked');
    },
  });
  const service = {
    supportsToolExecutionPolicy: () => false,
    supportsPluginTaskLaunch: () => true,
    async *invoke(prompt, options) {
      state.starts++;
      state.prompt = prompt;
      state.options = options;
      if (!silent) {
        yield { type: 'text', catId: 'codex', content: 'partial', timestamp: 1 };
        yield { type: 'text', catId: 'codex', content: 'Task result @opus', textMode: 'replace', timestamp: 2 };
      }
      if (fail) yield { type: 'error', catId: 'codex', error: 'failed', timestamp: 3 };
      else yield { type: 'done', catId: 'codex', timestamp: 3 };
    },
  };
  const execution = {
    async prepare(input) {
      state.childId = input.invocationId;
      state.registration = await registry.getRecord(input.invocationId);
      return {
        source: { messageId: 'trigger', content: 'Host Task trigger only' },
        launch: {
          server: { name: 'native', command: '/fixture/no-process', args: [], env: {}, transport: 'stdio' },
          sandbox: {
            kind: 'entrusted_work',
            workspaceRoot: '/fixture/task',
            runtimeSkillsRoot: '/fixture/skills',
            taskBinding: binding,
          },
          async assertCurrent() {
            input.signal.throwIfAborted();
            if (!state.current) throw Error('task_revoked');
          },
        },
        dispose() {
          state.disposals++;
        },
      };
    },
  };
  const forbidden = (name) => () => {
    state.ownerReads.push(name);
    throw Error('owner_context_read');
  };
  const agents = new AgentRegistry();
  agents.register('codex', service);
  const router = new AgentRouter({
    agentRegistry: agents,
    registry,
    messageStore: store,
    sessionStore: {},
    turnExecutionStore: new CallbackAuthTurnExecutionLifecycle(turns, registry),
    threadStore: { get: forbidden('thread history'), updateLastActive: forbidden('thread update') },
  });
  const options = {
    ownerAuthProvenance: 'unknown',
    humanDispositionInvocationOrigin: 'queue_replay',
    routingQueueSource: 'connector',
    parentInvocationId: 'parent',
    pluginTaskBinding: binding,
    pluginTaskExecution: execution,
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'instance',
      contributionId: 'private',
      actionMethods: ['private.read'],
    },
    async onPromptMessagesExposed(input) {
      state.exposure = input;
    },
  };
  const input = { userId: 'owner', threadId: 'thread', source: 'trigger', cats: ['codex'] };
  const iterator = () =>
    router
      .routeExecution(
        input.userId,
        'OWNER AGGREGATE MUST NOT BE USED',
        input.threadId,
        input.source,
        input.cats,
        { intent: 'execute' },
        options,
      )
      [Symbol.asyncIterator]();
  const run = async () => {
    const events = [];
    let error;
    try {
      for await (const event of { [Symbol.asyncIterator]: iterator }) events.push(event);
    } catch (e) {
      error = e;
    }
    return { events, error };
  };
  return { state, registry, turns, store, binding, execution, service, options, input, iterator, run };
}

test('Task route reaches real child registration without ordinary owner context', async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.error, undefined);
  assert.deepEqual(f.state.ownerReads, []);
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.prompt, 'Host Task trigger only');
  assert.deepEqual(f.state.registration.pluginTaskBinding, f.binding);
  assert.equal(f.turns.get(f.state.childId).status, 'succeeded');
  assert.notEqual((await f.registry.getRecord(f.state.childId)).state, 'active');
  assert.equal(f.state.disposals, 1);
  assert.ok(f.state.checks > 2);
  assert.deepEqual(
    result.events.filter((e) => e.type === 'text').map((e) => e.content),
    ['Task result @opus'],
  );
  const outputs = f.store.getByThread('thread');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].extra.stream.turnInvocationId, f.state.childId);
  assert.equal(outputs[0].extra.causal, undefined);
  assert.equal(outputs[0].replyTo, undefined);
  assert.deepEqual(outputs[0].mentions, []);
});

for (const [name, change] of [
  ['missing binding', (f) => delete f.options.pluginTaskBinding],
  ['missing execution', (f) => delete f.options.pluginTaskExecution],
  [
    'public execution mixed in',
    (f) => {
      f.options.publicInvocationExecution = f.execution;
    },
  ],
  [
    'public binding mixed in',
    (f) => {
      f.options.publicInvocationBinding = {};
    },
  ],
  [
    'foreign owner',
    (f) => {
      f.input.userId = 'other';
    },
  ],
  [
    'foreign thread',
    (f) => {
      f.input.threadId = 'other';
    },
  ],
  [
    'wrong source',
    (f) => {
      f.input.source = 'original';
    },
  ],
  [
    'multiple targets',
    (f) => {
      f.input.cats = ['codex', 'opus'];
    },
  ],
  [
    'strict owner',
    (f) => {
      f.options.ownerAuthProvenance = 'strict';
    },
  ],
  [
    'attachments',
    (f) => {
      f.options.contentBlocks = [{ type: 'text', text: 'private owner data' }];
    },
  ],
])
  test(`Task route rejects ${name} before ordinary context or provider`, async () => {
    const f = fixture();
    change(f);
    const result = await f.run();
    assert.match(result.error?.message ?? '', /task_route_identity_invalid/);
    assert.deepEqual(f.state.ownerReads, []);
    assert.equal(f.state.starts, 0);
  });

test('Task provider failure never publishes partial text or completion', async () => {
  const f = fixture({ fail: true }),
    result = await f.run();
  assert.equal(f.state.starts, 1);
  assert.match(result.error?.message ?? '', /task_route_child_unsuccessful/);
  assert.equal(result.events.filter((e) => e.type === 'text' || e.type === 'done').length, 0);
  assert.equal(f.store.getByThread('thread').length, 0);
  assert.equal(f.turns.get(f.state.childId).status, 'failed');
});
test('Task route may finish silently without inventing a progress receipt', async () => {
  const f = fixture({ silent: true }),
    result = await f.run();
  assert.equal(result.error, undefined);
  assert.equal(f.state.starts, 1);
  assert.equal(f.store.getByThread('thread').length, 0);
  assert.equal(result.events.filter((e) => e.type === 'done').length, 1);
});
test('Task route early close retires child credentials before provider starts', async () => {
  const f = fixture(),
    it = f.iterator();
  const first = await it.next();
  const child = JSON.parse(first.value.content).invocationId;
  assert.ok(child);
  const record = await f.registry.getRecord(child);
  await it.return();
  assert.equal((await f.registry.verifyLatest(child, record.callbackToken)).ok, false);
  assert.equal(f.turns.get(child).status, 'interrupted');
  assert.equal(f.state.starts, 0);
});
test('Task route rejects revoked currentness without ordinary fallback', async () => {
  const f = fixture();
  f.options.onPromptMessagesExposed = async () => {
    f.state.current = false;
  };
  const result = await f.run();
  assert.ok(result.error);
  assert.equal(f.state.starts, 0);
  assert.deepEqual(f.state.ownerReads, []);
  assert.equal(f.turns.get(f.state.childId).status, 'failed');
});
test('Task transcript failure does not replay a succeeded execution or publish unpersisted text', async () => {
  const f = fixture();
  f.store.append = () => {
    throw Error('transcript unavailable');
  };
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.equal(f.state.starts, 1);
  assert.equal(f.turns.get(f.state.childId).status, 'succeeded');
  assert.equal(result.events.filter((e) => e.type === 'text').length, 0);
  assert.equal(result.events.filter((e) => e.type === 'done').length, 1);
});
test('Task output commit fence rejects publication after successful execution', async () => {
  const f = fixture();
  f.options.beforeOutputCommit = async () => false;
  const result = await f.run();
  assert.match(result.error?.message ?? '', /task_route_output_rejected/);
  assert.equal(f.turns.get(f.state.childId).status, 'succeeded');
  assert.equal(result.events.filter((e) => e.type === 'text' || e.type === 'done').length, 0);
  assert.equal(f.store.getByThread('thread').length, 0);
});
test('Task route refuses provider without explicit Task launch support', async () => {
  const f = fixture();
  f.service.supportsPluginTaskLaunch = () => false;
  const result = await f.run();
  assert.match(result.error?.message ?? '', /task_execution_carrier_unavailable/);
  assert.equal(f.state.starts, 0);
  assert.deepEqual(f.state.ownerReads, []);
});

for (const field of ['pluginTaskBinding', 'pluginTaskExecution'])
  test(`Direct public route refuses ${field} without dropping the Task identity`, async () => {
    const options = {
      ownerAuthProvenance: 'unknown',
      publicInvocationBinding: { carrier: { targetCatId: 'codex', sourceMessageId: 'trigger' } },
      publicInvocationExecution: {},
      onPromptMessagesExposed() {},
      [field]: {},
    };
    const route = routePublicInvocation(
      {},
      { userId: 'owner', threadId: 'thread', userMessageId: 'trigger', targetCats: ['codex'], options },
    );
    await assert.rejects(async () => {
      for await (const _ of route) {
      }
    }, /public_route_identity_invalid/);
  });
