import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { _resetCachedConfig } from '../src/config/cat-config-loader.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueSourceCustodyAdmissionService } from '../src/domains/cats/services/agents/invocation/QueueSourceCustodyAdmission.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { callbackCustodyFixture, DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import type { DeferCase } from './f290-communication-a2a-custody-route.fixture.js';
import { CAT } from './f290-communication-validation.host.js';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';
import { scriptedSessionInit } from './helpers/scoped-test-sessions.js';

/** Real no-Queue callback consumer pushes the live production worklist; no manual worklist mutation. */
export async function inlineCustodyFixture(scope: 'private' | 'home', defer: DeferCase) {
  const config = createIsolatedTemplateRoot(
    tmpdir(),
    fileURLToPath(new URL('../../../cat-template.json', import.meta.url)),
  );
  const env = {
    CAT_CAFE_CONFIG_ROOT: config.root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: config.root,
    CAT_TEMPLATE_PATH: config.templatePath,
  };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  _resetCachedConfig();
  const restoreConfig = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCachedConfig();
    config.cleanup();
  };
  try {
    return await createInlineCustodyFixture(scope, defer, restoreConfig);
  } catch (error) {
    restoreConfig();
    throw error;
  }
}

async function createInlineCustodyFixture(scope: 'private' | 'home', defer: DeferCase, restoreConfig: () => void) {
  const f = await callbackCustodyFixture();
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  let threadId = f.task.threadId;
  const verified = await f.registry.verify(f.auth.invocationId, f.auth.callbackToken);
  assert.ok(verified.ok && verified.record.originTriggerMessageId);
  let triggerId = verified.record.originTriggerMessageId;
  if (scope === 'home') {
    threadId = f.threads.create(f.cafe.ownerUserId, 'Ordinary inline callback control').id;
    triggerId = f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId,
      catId: null,
      content: 'Ordinary home request',
      mentions: [],
      timestamp: Date.now(),
    }).id;
  }
  const controller = tracker.startAll(threadId, [CAT], f.cafe.ownerUserId, 'fixture-inline-parent');
  assert.ok(controller);
  if (defer === 'busy') tracker.startAll(threadId, [NEXT_CAT], f.cafe.ownerUserId, 'fixture-inline-occupied');
  const app = Fastify();
  const calls: { catId: string; policy?: string }[] = [];
  let delegatedSourceId: string | undefined;
  const first: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt, options) {
      calls.push({ catId: CAT, policy: options?.toolExecutionPolicy?.mode });
      yield* scriptedSessionInit(CAT, _prompt, options);
      const env = options?.callbackEnv;
      assert.ok(env?.CAT_CAFE_INVOCATION_ID && env.CAT_CAFE_CALLBACK_TOKEN);
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': env.CAT_CAFE_INVOCATION_ID, 'x-callback-token': env.CAT_CAFE_CALLBACK_TOKEN },
        payload: { content: 'Verified first-hop callback relay', targetCats: [DELEGATE] },
      });
      assert.equal(response.statusCode, 200, response.body);
      delegatedSourceId = response.json().messageId;
      yield {
        type: 'tool_use',
        catId: CAT,
        toolName: 'cat_cafe_post_message',
        toolInput: { targetCats: [DELEGATE] },
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: CAT, timestamp: Date.now() };
    },
  };
  const second: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt, options) {
      calls.push({ catId: DELEGATE, policy: options?.toolExecutionPolicy?.mode });
      yield* scriptedSessionInit(DELEGATE, _prompt, options);
      yield {
        type: 'text',
        catId: DELEGATE,
        content: `@${NEXT_CAT}\nFixture non-original B output`,
        timestamp: Date.now(),
      };
      if (defer === 'interrupted') controller.abort(new Error('Fixture non-original interruption'));
      yield { type: 'done', catId: DELEGATE, timestamp: Date.now() };
    },
  };
  const agents = new AgentRegistry();
  agents.register(CAT, first);
  agents.register(DELEGATE, second);
  agents.register(NEXT_CAT, {
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt, options) {
      calls.push({ catId: NEXT_CAT });
      yield* scriptedSessionInit(NEXT_CAT, _prompt, options);
      yield { type: 'done', catId: NEXT_CAT, timestamp: Date.now() };
    },
  });
  const router = new AgentRouter({
    ...f.sessionPorts,
    registry: f.registry,
    agentRegistry: agents,
    messageStore: f.messages,
    queueSourceCustodyAdmission: new QueueSourceCustodyAdmissionService({ queue, messageStore: f.messages }),
    threadStore: f.threads,
    taskStore: f.tasks,
    collectiveContext: () => f.context,
  });
  await app.register(callbacksRoutes, {
    registry: f.registry,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    router,
    invocationRecordStore: new InvocationRecordStore(),
    invocationTracker: tracker,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} } as never,
    evidenceStore: undefined as never,
    markerQueue: undefined as never,
    reflectionService: undefined as never,
  });
  return {
    ...f,
    queue,
    calls,
    threadId,
    async run() {
      const terminalCats = new Set<string>();
      const errors: string[] = [];
      for await (const event of routeSerial(
        router.getStrategyDeps(),
        [CAT],
        'Fixture inline relay',
        f.cafe.ownerUserId,
        threadId,
        {
          parentInvocationId: 'fixture-inline-parent',
          currentUserMessageId: triggerId,
          ownerAuthProvenance: 'unknown',
          signal: controller.signal,
          invocationController: controller,
          queueHasQueuedMessages: () => defer === 'pending',
          deferA2AEnqueue: (entry) => queue.enqueue(entry),
          trackA2ASlot: (tid, target, user, owner) => tracker.trackExternalSlot(tid, target, owner, user, [target]),
          completeA2ASlots: (tid, cats, owner) => {
            for (const target of cats) tracker.completeSlot(tid, target, owner);
          },
        },
      )) {
        if (event.type === 'done' && event.catId) terminalCats.add(event.catId);
        if (event.type === 'error' || event.errorCode)
          errors.push(`${event.catId}: ${String(event.error ?? event.errorCode)}`.slice(0, 1000));
      }
      assert.deepEqual(errors, [], `Inline callback route failed: ${errors.join('; ')}`);
      assert.ok(terminalCats.has(DELEGATE), 'Delegate must emit a real terminal route event before teardown');
      assert.ok(delegatedSourceId);
      return f.messages.getById(delegatedSourceId);
    },
    async close() {
      try {
        tracker.cancelAll(threadId);
        await app.close();
        await f.close();
      } finally {
        restoreConfig();
      }
    },
  };
}
