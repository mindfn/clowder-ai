import assert from 'node:assert/strict';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { documentWriterFixture } from './f290-communication-document-writer.fixture.js';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';
import { scopedTestSessions } from './helpers/scoped-test-sessions.js';

export const DELEGATE = createCatId('opus');
export const NEXT_CAT = createCatId('codex');

/** Real HTTP handler, router, canonical Queue and current Work authority. Busy slots prevent provider dispatch. */
export async function callbackCustodyFixture(agents = new AgentRegistry()) {
  const f = await documentWriterFixture();
  const sessionPorts = scopedTestSessions(f.cafe.dataDirectory);
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const sockets = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
  const router = new AgentRouter({
    ...sessionPorts,
    registry: f.registry,
    agentRegistry: agents,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    collectiveContext: () => f.context,
  });
  const app = Fastify();
  type QueueDeps = ConstructorParameters<typeof QueueProcessor>[0];
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    // Queue's older structural ports admit these concrete production implementations at runtime.
    invocationRecordStore: records as unknown as QueueDeps['invocationRecordStore'],
    router: router as unknown as QueueDeps['router'],
    messageStore: f.messages,
    socketManager: sockets as never,
    log: app.log,
  });
  tracker.startAll(f.task.threadId, [DELEGATE, NEXT_CAT], f.cafe.ownerUserId, 'fixture-busy-targets');
  await app.register(callbacksRoutes, {
    registry: f.registry,
    // Unrelated memory endpoints are not composed; the real post handler never consumes these ports.
    evidenceStore: undefined as never,
    markerQueue: undefined as never,
    reflectionService: undefined as never,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    socketManager: sockets as never,
    router,
    invocationRecordStore: records,
    invocationTracker: tracker,
    invocationQueue: queue,
    queueProcessor: processor,
  });
  const post = async (credentials: typeof f.auth, payload: Record<string, unknown>) => {
    const verified = await f.registry.verify(credentials.invocationId, credentials.callbackToken);
    if (
      verified.ok &&
      !f.messages.getByIdempotencyKey(
        verified.record.userId,
        verified.record.threadId!,
        `message-lifecycle-response:${credentials.invocationId}`,
      )
    ) {
      appendTestLifecycleResponseSource(f.messages, {
        userId: verified.record.userId,
        threadId: verified.record.threadId!,
        catId: verified.record.catId,
        invocationId: credentials.invocationId,
        timestamp: Date.now(),
      });
    }
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload,
    });
  };
  const firstHop = async () => {
    const first = await post(f.auth, { content: 'Validated same-Task collaboration', targetCats: [DELEGATE] });
    assert.equal(first.statusCode, 200, first.body);
    const source = await f.messages.getById(first.json().messageId);
    assert.ok(source?.extra?.collectiveWorkDelegationV1);
    const current = await f.context.resolvePrivate(
      {
        userId: f.cafe.ownerUserId,
        threadId: f.task.threadId,
        catId: DELEGATE,
        ownerAuthProvenance: 'unknown',
        originTriggerMessageId: source.id,
      },
      'admission',
    );
    assert.ok(current, 'Actual receiving Host admission must keep B on the original private Task');
    const verified = await f.registry.verify(f.auth.invocationId, f.auth.callbackToken);
    assert.ok(verified.ok && verified.record.collectiveWorkBinding);
    const credentials = await f.registry.create(
      f.cafe.ownerUserId,
      DELEGATE,
      f.task.threadId,
      undefined,
      undefined,
      undefined,
      source.id,
      'unknown',
      undefined,
      undefined,
      {
        ...verified.record.collectiveWorkBinding,
        sourceRef: current.sourceRef,
        authorityRef: current.work.authorityRef,
      },
    );
    return { source, current, credentials };
  };
  return {
    ...f,
    sessionPorts,
    queue,
    tracker,
    router,
    callbackApp: app,
    processor,
    post,
    firstHop,
    async close() {
      tracker.cancelAll(f.task.threadId);
      await app.close();
      await f.close();
    },
  };
}
