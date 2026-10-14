import './setup-cat-registry.js';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { A2ADispatchDispositionService } from '../../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { buildHandedEvent } from '../../dist/domains/ball-custody/ball-custody-events.js';
import { DispatchAdoptionAuthority } from '../../dist/domains/ball-custody/DispatchAdoptionAuthority.js';
import { DispatchReceiptService } from '../../dist/domains/ball-custody/DispatchReceiptService.js';
import { TurnCustodyAdoptionRegistry } from '../../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { LiveCompanionSessions } from '../../dist/domains/concierge/live/LiveCompanionSessions.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { liveDispatchAdoption } from '../../src/domains/concierge/live/live-dispatch-adoption.ts';
import { createA2ADispositionHarness } from './a2a-dispatch-disposition-harness.js';

export async function liveExactDispatchFixture({
  coalesced = false,
  authorityQueue = true,
  legacy = false,
  failReceiptOnce = false,
} = {}) {
  const registry = new InvocationRegistry();
  const h = await createA2ADispositionHarness({ registry, deliveryStatus: 'queued' });
  const identity = await registry.create('user-1', 'codex-sol', 'thread-1');
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore });
  const entry = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    content: h.source.content,
    messageId: h.source.id,
    source: 'agent',
    sourceCategory: 'a2a',
    callerCatId: 'fable5',
    targetCats: ['codex-sol'],
    intent: 'execute',
    ownerAuthProvenance: 'strict',
  }).entry;
  h.messageStore.initializeQueueCustody(h.source.id, createInitialQueuedMessageCustody(entry));

  const coalesce = async (content) => {
    const sibling = h.messageStore.append({
      userId: 'user-1',
      catId: 'fable5',
      threadId: 'thread-1',
      content,
      mentions: ['codex-sol'],
      timestamp: 1_100,
      deliveryStatus: 'queued',
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'codex-sol',
        messageId: sibling.id,
        at: sibling.timestamp,
      }),
    );
    assert.equal(queue.coalesceContentIntoQueuedAgent('thread-1', 'user-1', entry.id, content, sibling.id), true);
    const snapshot = queue.getEntrySnapshot('thread-1', 'user-1', entry.id);
    h.messageStore.initializeQueueCustody(sibling.id, createInitialQueuedMessageCustody(snapshot));
    await coordinator.persistEntry(snapshot);
    return sibling;
  };

  const sibling = coalesced ? await coalesce('merged sibling body') : undefined;
  queue.markQueuedSeen('thread-1', 'user-1', entry.id, 'codex-sol', identity.invocationId, 500);
  await coordinator.persistEntry(queue.getEntrySnapshot('thread-1', 'user-1', entry.id));

  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: identity.invocationId,
    parentInvocationId: identity.invocationId,
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
    startedAt: Date.now(),
  });
  const sessions = new LiveCompanionSessions();
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue,
    coordinator,
    eventLog: h.eventLog,
  });
  const adoption = liveDispatchAdoption({ sessions, receipts, messageStore: h.messageStore });
  let rejectReceipt = failReceiptOnce;
  const projectAdoptedDisposition = failReceiptOnce
    ? async (input) => {
        if (rejectReceipt) {
          rejectReceipt = false;
          throw new Error('synthetic receipt projection failure');
        }
        return adoption.projectAdoptedDisposition(input);
      }
    : adoption.projectAdoptedDisposition;
  const service = new A2ADispatchDispositionService({
    registry,
    messageStore: h.messageStore,
    ballCustodyEventLog: h.eventLog,
    ballCustodyProjectionStore: h.projectionStore,
    ballCustody: h.ingest,
    ...adoption,
    projectAdoptedDisposition,
    ...(legacy
      ? {}
      : {
          adoptionAuthority: new DispatchAdoptionAuthority({
            executions,
            messages: h.messageStore,
            ...(authorityQueue ? { queue } : {}),
            adoptions: new TurnCustodyAdoptionRegistry(),
            live: sessions,
          }),
        }),
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: h.messageStore,
    invocationQueue: queue,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    withLiveCarrierOperation: adoption.withLiveCarrierOperation,
    ballCustodyEventLog: h.eventLog,
    holdBallDeps: { registry, a2aDispatchDispositionService: service },
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
  });
  const apiUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const call = await sessions.prepare({
    binding: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', callId: 'call' },
    messageStore: h.messageStore,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    publish() {},
  });
  sessions.claim(call.id, 'user-1', 'thread-1', ['codex-sol']);
  await call.configure({
    CAT_CAFE_API_URL: apiUrl,
    CAT_CAFE_USER_ID: 'user-1',
    CAT_CAFE_THREAD_ID: 'thread-1',
    CAT_CAFE_CAT_ID: 'codex-sol',
    CAT_CAFE_INVOCATION_ID: identity.invocationId,
    CAT_CAFE_CALLBACK_TOKEN: identity.callbackToken,
  });
  await call.ready('native', { request: async () => ({}), submitText: async () => 'unused' });
  const headers = { 'x-invocation-id': identity.invocationId, 'x-callback-token': identity.callbackToken };
  return {
    ...h,
    queue,
    coordinator,
    entry,
    sibling,
    coalesce,
    read: (source) =>
      app.inject({
        method: 'GET',
        url: `/api/callbacks/thread-context?messageId=${source.id}&before=0&after=0&responseMode=full`,
        headers,
      }),
    complete: (source) =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/complete-a2a-dispatch',
        headers,
        payload: { disposition: 'completed', adoptSourceMessageId: source.id },
      }),
    close: async () => {
      await sessions.close();
      await app.close();
    },
  };
}
