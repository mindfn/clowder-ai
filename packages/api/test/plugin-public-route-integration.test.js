import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CallbackAuthTurnExecutionLifecycle } from '../src/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.ts';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.ts';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { resolveRestartTargets } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyRestartTargets.ts';
import { QueuedMessageCustodyStartupReconciler } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.ts';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { resolveQueueSourceResponseEvidence } from '../src/domains/cats/services/agents/invocation/queue-source-response-evidence.ts';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.ts';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { createPublicQueueExecution } from '../src/domains/plugin/carrier/public-queue-execution.ts';

let auditDir;
let previousAuditDir;
before(async () => {
  previousAuditDir = process.env.AUDIT_LOG_DIR;
  auditDir = await mkdtemp(join(tmpdir(), 'public-route-integration-'));
  process.env.AUDIT_LOG_DIR = auditDir;
});
after(async () => {
  if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
  else process.env.AUDIT_LOG_DIR = previousAuditDir;
  await rm(auditDir, { recursive: true, force: true });
});

function fixture({ fail = false, replace = false, silent = false } = {}) {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const registry = new InvocationRegistry();
  const turns = new InMemoryTurnExecutionStore();
  const state = { broadcasts: [], chunks: [], ownerReads: [], starts: 0, prepares: 0, disposals: 0, exposures: [] };
  const sourceId = '0000000000001000-000001-00000001';
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: sourceId,
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'codex',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const { entry } = queue.enqueue({
    threadId: 'thread',
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'public source only',
    messageId: sourceId,
    targetCats: ['codex'],
    intent: 'execute',
    autoExecute: true,
    pluginPublicInvocation: carrier,
  });
  store.append({
    reservedId: sourceId,
    threadId: 'thread',
    userId: 'owner',
    catId: null,
    content: entry.content,
    mentions: ['codex'],
    timestamp: 1000,
    source: { connector: 'fixture' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 } },
  });
  assert.equal(store.prepareQueueAdmission(sourceId).kind, 'prepared');
  assert.equal(store.initializeQueueCustody(sourceId, createInitialQueuedMessageCustody(entry)).kind, 'initialized');
  const lifecycle = new CallbackAuthTurnExecutionLifecycle(turns, registry);
  const custody = new QueuedMessageCustodyCoordinator({ messageStore: store });
  const service = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt, options) {
      assert.equal(turns.get(state.childId)?.queueCompletionPolicy, undefined);
      assert.deepEqual(turns.get(state.childId)?.causal?.coveredMessageIds, [sourceId]);
      state.starts++;
      state.prompt = prompt;
      state.options = options;
      if (!silent) yield { type: 'text', catId: 'codex', content: 'Host execution note @opus', timestamp: 2000 };
      if (replace)
        yield { type: 'text', catId: 'codex', content: 'final answer', textMode: 'replace', timestamp: 2001 };
      if (fail) yield { type: 'error', catId: 'codex', error: 'provider failure', timestamp: 2001 };
      else yield { type: 'done', catId: 'codex', timestamp: 2001 };
    },
  };
  const execution = {
    async prepare(input) {
      state.prepares++;
      state.childId = input.invocationId;
      const existingChild = store.getById(sourceId).queueCustody.awakenedInvocationIdByCatId?.codex;
      if (existingChild === undefined) {
        const bound = await custody.bindPublicInvocationChild({ entry, invocationId: input.invocationId });
        assert.equal(bound.kind, 'bound');
      } else assert.equal(existingChild, input.invocationId);
      return {
        source: { messageId: sourceId, content: entry.content },
        launch: {
          server: { name: 'native', command: '/fixture/no-process', args: [], env: {}, transport: 'stdio' },
          sandbox: { kind: 'public', workspaceRoot: '/fixture/public-workspace' },
          async assertCurrent() {
            input.signal.throwIfAborted();
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
    throw new Error('owner_context_read');
  };
  const agents = new AgentRegistry();
  agents.register('codex', service);
  const router = new AgentRouter({
    agentRegistry: agents,
    registry,
    messageStore: store,
    sessionStore: {},
    turnExecutionStore: lifecycle,
    threadStore: { get: forbidden('thread history'), updateLastActive: forbidden('thread update') },
  });
  const binding = { version: 1, entryId: entry.id, carrier };
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'instance',
    contributionId: 'native',
    actionMethods: ['native.read'],
  };
  const exposed = async (input) => {
    state.exposures.push(input);
  };
  const routeOptions = {
    ownerAuthProvenance: 'unknown',
    humanDispositionInvocationOrigin: 'queue_replay',
    routingQueueSource: 'connector',
    parentInvocationId: 'parent',
    publicInvocationBinding: binding,
    publicInvocationExecution: execution,
    toolExecutionPolicy: policy,
    onPromptMessagesExposed: exposed,
  };
  const runRoute = async () => {
    const messages = [];
    let error;
    try {
      for await (const message of router.routeExecution(
        'owner',
        'UNTRUSTED ROUTE AGGREGATE',
        'thread',
        sourceId,
        ['codex'],
        { intent: 'execute' },
        routeOptions,
      ))
        messages.push(message);
    } catch (caught) {
      error = caught;
    }
    return { messages, error };
  };
  return {
    store,
    queue,
    registry,
    turns,
    state,
    sourceId,
    entry,
    custody,
    service,
    execution,
    binding,
    policy,
    router,
    exposed,
    routeOptions,
    runRoute,
  };
}

test('public route control: existing child executor runs through durable binding', async () => {
  const f = fixture();
  const params = {
    catId: 'codex',
    userId: 'owner',
    threadId: 'thread',
    ownerAuthProvenance: 'unknown',
    prompt: 'ignored route prompt',
    isLastCat: true,
    parentInvocationId: 'parent',
    service: f.service,
    publicInvocationBinding: f.binding,
    publicInvocationExecution: f.execution,
    toolExecutionPolicy: f.policy,
    executionCausal: { triggerMessageId: f.sourceId },
    promptMessageIds: [f.sourceId],
    onPromptMessagesExposed: f.exposed,
  };
  for await (const _ of invokeSingleCat(
    { registry: f.registry, turnExecutionStore: f.turns, apiUrl: 'http://127.0.0.1:1' },
    params,
  )) {
    /* drain lifecycle */
  }
  assert.equal(f.state.starts, 1);
  assert.equal((await f.turns.get(f.state.childId)).status, 'succeeded');
  assert.equal(f.store.getById(f.sourceId).queueCustody.awakenedInvocationIdByCatId.codex, f.state.childId);
});

test('public route control: existing exact source evidence recognizes standard output', async () => {
  const f = fixture();
  const output = f.store.append({
    userId: 'owner',
    threadId: 'thread',
    catId: 'codex',
    content: 'reply',
    timestamp: 2000,
    mentions: [],
    origin: 'stream',
    replyTo: f.sourceId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child' },
      causal: { kind: 'invocation_reply', triggerMessageId: f.sourceId },
    },
  });
  const evidence = await resolveQueueSourceResponseEvidence({
    messageStore: f.store,
    threadId: 'thread',
    userId: 'owner',
    catId: 'codex',
    invocationId: 'child',
    sourceMessageIds: [f.sourceId],
  });
  assert.deepEqual(evidence[0].witness.outputMessageIds, [output.id]);
});

test('public production route forwards isolated execution without reading owner context', async () => {
  const f = fixture();
  await f.runRoute();
  assert.deepEqual(f.state.ownerReads, [], 'public production route must reach isolated execution');
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.prompt, f.entry.content);
  assert.equal(f.state.disposals, 1);
});

test('public production route persists a Host transcript without claiming a plugin reply', async () => {
  const f = fixture();
  await f.runRoute();
  const outputs = f.store.getByThread('thread').filter((message) => message.catId === 'codex');
  assert.equal(outputs.length, 1, 'public production route must persist exact reply');
  assert.equal(outputs[0].extra.stream.turnInvocationId, f.state.childId);
  assert.equal(outputs[0].extra.causal, undefined);
  assert.equal(outputs[0].replyTo, undefined);
  assert.equal(outputs[0].extra.publicOutputV1, undefined);
  const evidence = await resolveQueueSourceResponseEvidence({
    messageStore: f.store,
    threadId: 'thread',
    userId: 'owner',
    catId: 'codex',
    invocationId: f.state.childId,
    sourceMessageIds: [f.sourceId],
  });
  assert.deepEqual(evidence, [], 'Host transcript is not a plugin reply receipt');
  assert.deepEqual(outputs[0].mentions, []);
});

test('public production route failure runs once and cannot publish partial text as success', async () => {
  const f = fixture({ fail: true });
  await f.runRoute();
  assert.equal(f.state.starts, 1, 'public production route must execute its restricted provider');
  assert.equal((await f.turns.get(f.state.childId)).status, 'failed');
  assert.equal(f.store.getByThread('thread').filter((message) => message.catId === 'codex').length, 0);
});

async function runQueue(f, beforeSettle = async () => {}, start = (processor) => processor.tryAutoExecute('thread')) {
  let calls = 0;
  const parents = new InvocationRecordStore();
  const errors = [];
  const processor = new QueueProcessor({
    queue: f.queue,
    messageStore: f.store,
    queueCustodyCoordinator: f.custody,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: parents,
    turnExecutionStore: f.turns,
    publicInvocationExecution: f.execution,
    router: {
      async *routeExecution(...args) {
        calls++;
        yield* f.router.routeExecution(...args);
      },
      async ackCollectedCursors() {},
    },
    socketManager: {
      broadcastAgentMessage(message) {
        f.state.broadcasts.push(message);
      },
      broadcastToRoom() {},
      emitToUser() {},
    },
    streamingHook: {
      async onStreamStart() {},
      async onStreamChunk(_thread, content) {
        f.state.chunks.push(content);
      },
      async onStreamEnd() {},
    },
    log: {
      info() {},
      warn() {},
      error(...args) {
        errors.push(args);
      },
    },
  });
  let finish, reject;
  const settled = new Promise((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  const complete = processor.onInvocationComplete.bind(processor);
  processor.onInvocationComplete = async (...args) => {
    try {
      await beforeSettle({ parents });
      await complete(...args);
      finish(args[2]);
    } catch (error) {
      reject(error);
      throw error;
    }
  };
  await start(processor);
  const status = await settled;
  return { processor, parents, status, calls, errors };
}

test('public production Queue completes the child without treating its Host transcript as a reply', async () => {
  const f = fixture();
  const result = await runQueue(f);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.calls, 1);
  assert.equal(f.state.starts, 1);
  assert.deepEqual(f.state.ownerReads, []);
  const source = f.store.getById(f.sourceId);
  assert.deepEqual(source.queueCustody.handledByCatIds, ['codex']);
  assert.equal(source.queueCustody.targetOutcomeByCatId.codex.disposition, 'completed_with_turn');
  assert.equal(source.queueCustody.targetOutcomeByCatId.codex.invocationId, f.state.childId);
  await result.processor.tryAutoExecute('thread');
  assert.equal(f.state.starts, 1);
});

test('public Queue failure retains child binding and rejects generic retry', async () => {
  const f = fixture({ fail: true });
  const result = await runQueue(f);
  assert.equal(result.status, 'failed');
  assert.equal(f.state.starts, 1);
  const source = f.store.getById(f.sourceId);
  assert.equal(source.queueCustody.targetAttempts[0].invocationId, f.state.childId);
  assert.ok(source.queueCustody.failedByCatIds.includes('codex'));
  assert.equal(f.queue.retryFailedTarget('thread', 'owner', f.entry.id, 'codex'), null);
  await result.processor.tryAutoExecute('thread');
  assert.equal(f.state.starts, 1);
});

test('restart after child completion recovers completion without another provider', async () => {
  const f = fixture();
  await runQueue(f, async ({ parents }) => {
    const source = f.store.getById(f.sourceId);
    assert.equal(source.queueCustody.handledByCatIds.length, 0);
    const projection = await resolveRestartTargets(
      source,
      source.queueCustody,
      f.store,
      parents,
      f.turns,
      new Set(),
      Date.now(),
    );
    assert.ok(projection.handled.has('codex'));
    assert.equal(projection.targetOutcomeByCatId.codex.disposition, 'completed_with_turn');
    assert.equal(f.state.starts, 1);
  });
});

test('production startup resumes a reconciled public source through the same dispatcher', async () => {
  const f = fixture();
  const restored = new InvocationQueue();
  // Memory mode intentionally has no startup scan (#697). Supply the durable
  // index seam for this one-source fixture; all reads/CAS and reconciliation stay real.
  f.store.scanByDeliveryStatus = (status) =>
    [f.sourceId].filter((id) => f.store.getById(id)?.deliveryStatus === status);
  const recoveryWarnings = [];
  const result = await new QueuedMessageCustodyStartupReconciler({
    messageStore: f.store,
    invocationRecordStore: new InvocationRecordStore(),
    turnExecutionStore: f.turns,
    invocationQueue: restored,
    log: {
      info() {},
      warn(message) {
        recoveryWarnings.push(message);
      },
    },
  }).reconcile();
  assert.deepEqual(recoveryWarnings, []);
  assert.equal(result.entriesRestored, 1, JSON.stringify(result));
  assert.deepEqual(result.resumeScopes, [{ threadId: 'thread', userId: 'owner' }]);
  const restoredEntry = restored.getEntrySnapshot('thread', 'owner', f.entry.id);
  assert.deepEqual(restoredEntry.queuedAwakenedInvocationIdByCatId, {});
  assert.deepEqual(restoredEntry.queuedSeenInvocationIdByCatId, {});
  const claim = restored.claimPublicInvocation.bind(restored);
  restored.claimPublicInvocation = (...args) => {
    const claimed = claim(...args);
    assert.ok(claimed, 'startup must claim a source whose restored child maps are empty');
    return claimed;
  };
  f.queue = restored;
  // index.ts must call this tested production hook, not ordinary processNext alone.
  const startup = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(startup, /await queueProcessor\.resumeAfterStartup\(scope\.threadId, scope\.userId\)/);
  await runQueue(f, undefined, async (processor) => {
    // The old startup call alone cannot claim a public carrier (review1376).
    await processor.processNext('thread', 'owner');
    assert.equal(f.state.starts, 0);
    for (const scope of result.resumeScopes) await processor.resumeAfterStartup(scope.threadId, scope.userId);
  });
  assert.equal(f.state.starts, 1);
  assert.equal(f.store.getById(f.sourceId).queueCustody.targetAttempts.length, 1);
});

test('public claim refuses restored entries with an existing child witness', () => {
  for (const field of ['queuedAwakenedInvocationIdByCatId', 'queuedSeenInvocationIdByCatId']) {
    const f = fixture();
    const restored = new InvocationQueue();
    restored.restoreDurableEntry({ ...f.entry, [field]: { codex: 'existing-child' } });
    assert.equal(restored.claimPublicInvocation('thread', 'owner', f.entry.id), null, field);
    assert.equal(restored.getEntrySnapshot('thread', 'owner', f.entry.id).status, 'queued');
    assert.equal(f.state.starts, 0);
  }
});

test('runtime preparation uses exact registered public identity and expires with child', async () => {
  const f = fixture();
  let seen;
  f.routeOptions.publicInvocationExecution = createPublicQueueExecution(f.registry, () => ({
    async preparePublicInvocationExecution(instance, carrier, binding, context) {
      seen = { instance, carrier, binding, context };
      await context.assertCurrent();
      return f.execution.prepare({
        invocationId: binding.invocationId,
        sourceMessageId: carrier.sourceMessageId,
        signal: context.signal,
      });
    },
  }));
  const result = await f.runRoute();
  assert.equal(result.error, undefined);
  assert.equal(seen.instance, 'instance');
  assert.equal(seen.binding.entryId, f.entry.id);
  assert.equal(seen.binding.invocationId, f.state.childId);
  assert.equal(seen.context.signal.aborted, true);
  await assert.rejects(seen.context.assertCurrent(), /public_execution_closed/);
});

test('public Router rejects target mismatch before any owner or provider access', async () => {
  const f = fixture();
  f.routeOptions.publicInvocationBinding = { ...f.binding, carrier: { ...f.binding.carrier, targetCatId: 'opus' } };
  const result = await f.runRoute();
  assert.match(result.error.message, /public_route_identity_invalid/);
  assert.equal(f.state.starts, 0);
  assert.deepEqual(f.state.ownerReads, []);
});

test('public review: failed provider cannot expose partial text to socket or streaming', async () => {
  const f = fixture({ fail: true });
  await runQueue(f);
  assert.equal(
    f.state.broadcasts.filter((m) => m.type === 'text').length,
    0,
    'public failure must not publish partial text',
  );
  assert.deepEqual(f.state.chunks, [], 'public failure must not publish partial text');
});

test('public review: replace text persists and publishes only the final aggregate', async () => {
  const f = fixture({ replace: true });
  const result = await f.runRoute();
  const outputs = f.store.getByThread('thread').filter((m) => m.catId === 'codex');
  assert.equal(outputs[0]?.content, 'final answer', 'public replace must preserve final aggregate');
  assert.equal(
    result.messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'final answer',
  );
});

test('public execution may finish silently without a Host output or reply receipt', async () => {
  const f = fixture({ silent: true });
  const result = await runQueue(f);
  assert.equal(result.status, 'succeeded');
  assert.equal(f.state.starts, 1);
  assert.equal(f.store.getById(f.sourceId).queueCustody.targetOutcomeByCatId.codex.disposition, 'completed_with_turn');
  assert.equal(f.store.getByThread('thread').filter((m) => m.catId === 'codex').length, 0);
  assert.deepEqual(f.state.chunks, []);
});

test('Host transcript write failure does not replay a completed native execution or publish text', async () => {
  const f = fixture();
  const append = f.store.append.bind(f.store);
  f.store.append = (input) => {
    if (input.catId === 'codex') throw new Error('injected transcript storage failure');
    return append(input);
  };
  const result = await runQueue(f);
  assert.equal(result.status, 'succeeded');
  assert.equal(f.turns.get(f.state.childId).status, 'succeeded');
  assert.equal(f.store.getById(f.sourceId).queueCustody.targetOutcomeByCatId.codex.disposition, 'completed_with_turn');
  assert.equal(f.queue.retryFailedTarget('thread', 'owner', f.entry.id, 'codex'), null);
  assert.equal(f.state.starts, 1);
  assert.deepEqual(f.state.chunks, []);
  assert.equal(f.state.broadcasts.filter((m) => m.type === 'text').length, 0);
});
