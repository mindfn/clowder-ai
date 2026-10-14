import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify from 'fastify';
import { turnCustodyAdoptionRegistry } from '../src/domains/ball-custody/TurnCustodyAdoptionRegistry.js';
import { TurnCustodyProjectionService } from '../src/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { CollectiveIngressDispatcher } from '../src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.js';
import { createWorld, postNaturalRequest } from './f290-communication-validation.harness.js';
import { CAT, until } from './f290-communication-validation.host.js';
import { scopedTestSessions, scriptedSessionInit } from './helpers/scoped-test-sessions.js';

/** Production Service/Connector/ingress/router/Queue; only the provider and Human login are fixtures. */
export async function publicTerminalFixture(
  scenario: { forgedReply?: boolean; adoptHold?: boolean; providerFails?: boolean } = {},
) {
  const world = await createWorld();
  const cafe = world.operator;
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create(cafe.ownerUserId, 'Public exact-source terminal');
  threads.addParticipants(thread.id, [CAT]);
  const revision = await world.declareCats(cafe, [CAT], { threadId: thread.id });
  const context = new CollectiveCurrentContext({
    connector: () => cafe.connector,
    messageStore: messages,
    threadStore: threads,
  });
  const registry = new InvocationRegistry();
  const sessionPorts = scopedTestSessions(cafe.dataDirectory);
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const app = Fastify();
  let calls = 0;
  let acceptedEventId: string | undefined;
  let lastAuth: Awaited<ReturnType<typeof registry.peekRecord>>;
  const hooks: { afterReply?: () => Promise<void> } = {};
  const broadcasts: Record<string, unknown>[] = [];
  const service: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt, options) {
      calls++;
      assert.ok(options?.callbackEnv);
      const verified = await registry.verify(
        options.callbackEnv.CAT_CAFE_INVOCATION_ID!,
        options.callbackEnv.CAT_CAFE_CALLBACK_TOKEN!,
      );
      assert.ok(verified.ok);
      lastAuth = verified.record;
      world.turns.set(lastAuth.invocationId, { catId: CAT, status: 'running' });
      yield* scriptedSessionInit(CAT, prompt, options);
      if (scenario.adoptHold) {
        const hold = messages.append({
          userId: cafe.ownerUserId,
          threadId: thread.id,
          catId: null,
          mentions: [],
          timestamp: Date.now(),
          content: 'Existing managed hold wake',
          source: {
            connector: 'hold-ball',
            label: 'Managed wake',
            icon: '🧶',
            meta: { wakeWhen: true, taskId: 'fixture-unsettled-hold' },
          },
        });
        assert.equal(
          await turnCustodyAdoptionRegistry.adopt(lastAuth.invocationId, [
            {
              kind: 'structured',
              protocol: 'hold',
              subjectKey: `ball:thread:${thread.id}`,
              holderCatId: CAT,
              sourceMessageId: hold.id,
              taskId: 'fixture-unsettled-hold',
            },
          ]),
          true,
        );
      }
      const current = await context.current(lastAuth);
      if (!scenario.forgedReply && current.reply.status !== 'accepted') {
        const result = await context.reply(
          lastAuth,
          current.returnRef,
          current.replyOperationRef,
          'PUBLIC_TERMINAL_OK',
        );
        assert.equal(result.reply.status, 'accepted');
        acceptedEventId = result.reply.eventId;
        await hooks.afterReply?.();
      }
      yield { type: 'text', catId: CAT, content: 'Public reply delivered', timestamp: Date.now() };
      if (scenario.providerFails)
        yield { type: 'error', catId: CAT, error: 'fixture provider failed', timestamp: Date.now() };
      yield {
        type: 'done',
        catId: CAT,
        timestamp: Date.now(),
        ...(scenario.forgedReply
          ? {
              turnCustodyTerminalWitness: {
                kind: 'collective_public_reply' as const,
                sourceMessageId: lastAuth.originTriggerMessageId!,
                sourceEventId: lastAuth.executionGrant!.source.eventId,
                acceptedEventId: 'evt_forged',
              },
            }
          : {}),
      };
    },
  };
  const agents = new AgentRegistry();
  agents.register(CAT, service);
  const projection = new TurnCustodyProjectionService({});
  const router = new AgentRouter({
    ...sessionPorts,
    registry,
    agentRegistry: agents,
    messageStore: messages,
    threadStore: threads,
    collectiveContext: () => context,
    turnCustodyProjectionService: projection,
  });
  const sockets = {
    broadcastAgentMessage(message: Record<string, unknown>) {
      broadcasts.push(message);
    },
    broadcastToRoom() {},
    emitToUser() {},
  };
  type QueueDeps = ConstructorParameters<typeof QueueProcessor>[0];
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: records as unknown as QueueDeps['invocationRecordStore'],
    router: router as unknown as QueueDeps['router'],
    messageStore: messages,
    turnExecutionStore: sessionPorts.turnExecutionStore,
    queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: messages }),
    socketManager: sockets as never,
    log: app.log,
  });
  const ingress = new CollectiveIngressDispatcher({
    connector: cafe.connector,
    threadStore: threads,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: processor,
    socketManager: sockets,
    isCatAvailable: () => true,
  });
  return {
    world,
    cafe,
    messages,
    threads,
    thread,
    registry,
    context,
    queue,
    tracker,
    processor,
    projection,
    hooks,
    broadcasts,
    records,
    executions: sessionPorts.turnExecutionStore,
    get calls() {
      return calls;
    },
    get acceptedEventId() {
      return acceptedEventId;
    },
    get lastAuth() {
      return lastAuth;
    },
    async stateBytes() {
      return readFile(join(cafe.dataDirectory, 'collective-connector.json'));
    },
    async run() {
      const request = await postNaturalRequest(world, cafe, cafe, CAT, 'Reply once without accepting Work', revision);
      await cafe.connector.sync(cafe.connectionId);
      const result = await ingress.dispatchConnection(cafe.connectionId);
      assert.equal(result.failed, 0, JSON.stringify(await cafe.connector.listInbox(cafe.connectionId)));
      await until(
        () => {
          // Tracker release precedes async Queue settlement, including failed aggregates.
          const source = messages
            .getByThreadIncludingQueued(thread.id, 100, cafe.ownerUserId)
            .find((message) => message.source?.meta?.eventId === request.eventId);
          return (
            calls > 0 &&
            !tracker.has(thread.id) &&
            source?.deliveryStatus === 'delivered' &&
            source.queueCustody?.status === 'terminal' &&
            (scenario.adoptHold || scenario.providerFails || queue.list(thread.id, cafe.ownerUserId).length === 0)
          );
        },
        'real exact-source Queue terminal',
        20000,
      );
      const source = messages
        .getByThread(thread.id)
        .find((message) => message.source?.meta?.eventId === request.eventId);
      assert.ok(source);
      return {
        request,
        source,
        events: await world.store.listEventsForHuman(cafe.sessionToken, world.coordinates.collectiveId),
      };
    },
    async close() {
      tracker.cancelAll(thread.id);
      await app.close();
      await world.close();
    },
  };
}
