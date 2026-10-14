import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

for (const failure of [
  'missing-owner',
  'preparation-error',
  'source-resolution-error',
  'removed-in-resolver',
  'removed-in-prepare',
  'eligibility-changed-in-prepare',
]) {
  test(`full context ${failure} rejects before queued or published body exposure`, async () => {
    const { QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { turnCustodyAdoptionRegistry } = await import('../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js');
    const invocationQueue = new InvocationQueue();
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    let wake;
    let originalEntry;
    let committed = 0;
    const queueProcessor = {
      resolvePromptMessageCustodyWakes: async () => {
        if (failure === 'source-resolution-error') throw new Error('original source resolver error');
        if (failure === 'removed-in-resolver')
          assert.equal(invocationQueue.removeEntrySnapshotIfUnchanged(originalEntry), true);
        return [wake];
      },
    };
    const sourceStore = new MessageStore();
    const { app, messageStore, headers, invocationId } = await setup({
      messageStore: sourceStore,
      invocationQueue,
      turnExecutionStore,
      deliveryCursorStore,
      queueProcessor,
      queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore: sourceStore }),
    });
    let unregister;
    try {
      await turnExecutionStore.createRunning({
        invocationId,
        parentInvocationId: invocationId,
        threadId: 'default',
        userId: 'default-user',
        catId: 'codex61-sol',
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      messageStore.append({
        userId: 'default-user',
        catId: null,
        content: 'ordinary published body',
        mentions: [],
        timestamp: 1,
      });
      const { entry } = invocationQueue.enqueue({
        ownerAuthProvenance: 'strict',
        threadId: 'default',
        userId: 'default-user',
        content: 'managed completion body',
        source: 'connector',
        targetCats: ['codex61-sol'],
        intent: 'execute',
      });
      const stored = messageStore.append({
        userId: 'default-user',
        threadId: 'default',
        catId: null,
        content: entry.content,
        mentions: ['codex61-sol'],
        timestamp: 2,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(entry),
      });
      invocationQueue.backfillMessageId('default', 'default-user', entry.id, stored.id);
      originalEntry = invocationQueue.getEntrySnapshot('default', 'default-user', entry.id);
      wake = {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:default',
        holderCatId: 'codex61-sol',
        sourceMessageId: stored.id,
        taskId: 'completion-awaiting-read',
      };
      if (failure === 'preparation-error')
        unregister = turnCustodyAdoptionRegistry.register(invocationId, async () => {
          throw new Error('original custody preparation error');
        });
      if (failure.startsWith('removed-') || failure === 'eligibility-changed-in-prepare')
        unregister = turnCustodyAdoptionRegistry.register(invocationId, async () => {
          if (failure === 'removed-in-prepare')
            assert.equal(invocationQueue.removeEntrySnapshotIfUnchanged(originalEntry), true);
          if (failure === 'eligibility-changed-in-prepare')
            assert.equal(
              invocationQueue.markQueuedFailedForCatAcrossUsers(
                'default',
                'codex61-sol',
                invocationId,
                new Set([entry.id]),
              ).length,
              1,
            );
          return () => {
            committed += 1;
          };
        });
      const response = await app.inject({
        url: '/api/callbacks/thread-context?readIntent=unread&responseMode=full',
        headers,
      });
      assert.equal(
        response.statusCode,
        failure === 'missing-owner' || failure.startsWith('removed-') || failure === 'eligibility-changed-in-prepare'
          ? 409
          : 503,
        response.body,
      );
      assert.equal(
        response.json().code,
        failure.startsWith('removed-') || failure === 'eligibility-changed-in-prepare'
          ? 'QUEUED_BODY_SOURCE_CHANGED'
          : 'TURN_CUSTODY_ADOPTION_UNAVAILABLE',
      );
      assert.equal(committed, 0);
      const snapshot = invocationQueue.getEntrySnapshot('default', 'default-user', entry.id);
      assert.equal(snapshot?.queuedSeenByCatIds?.includes('codex61-sol') ?? false, false);
      assert.equal(snapshot?.queuedBodyExposures?.length ?? 0, 0);
      assert.equal(messageStore.getById(stored.id).queueCustody.bodyExposures?.length ?? 0, 0);
      assert.equal(await deliveryCursorStore.getSeenCursor('default-user', 'codex61-sol', 'default'), undefined);
    } finally {
      await unregister?.();
      turnCustodyAdoptionRegistry.resetForTest();
      await app.close();
    }
  });
}

async function setup(overrides = {}) {
  const messageStore = overrides.messageStore ?? new MessageStore();
  const threadStore = new ThreadStore();
  const registry = new InvocationRegistry();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} },
    ...overrides,
  });
  const { invocationId, callbackToken } = await registry.create('default-user', 'codex61-sol');
  const headers = { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
  return { app, messageStore, headers, invocationId };
}
