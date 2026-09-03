import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const action = {
  subjectRef: 'pr:owner/repo#4058',
  actionFamily: 'review',
  successorSlot: 'reviewer',
  mode: 'single',
  terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
};

function carrierLease(sourceThreadId, targetThreadId) {
  return {
    leaseId: 'lease-review-4058',
    key: 'user-1|pr:owner/repo#4058|review|reviewer',
    tenantScope: 'user-1',
    subjectRef: action.subjectRef,
    actionFamily: action.actionFamily,
    successorSlot: action.successorSlot,
    mode: action.mode,
    holderCatIds: ['codex'],
    dispatchId: 'cross-post:review-4058-original',
    claimOrigin: 'structured_transfer',
    holderThreadId: targetThreadId,
    predecessorCatId: 'opus',
    predecessorThreadId: sourceThreadId,
    issuerStandingEvidenceRef: 'callback:old-invocation:review-4058-original',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: action.actionFamily,
      subjectRef: action.subjectRef,
      predicate: action.terminalPredicate,
    }),
    evidenceRefs: ['callback:old-invocation:review-4058-original'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
  };
}

async function appendCarrier(messageStore, invocationQueue, lease, state) {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  const from = { kind: 'agent', catId: lease.predecessorCatId };
  const message = await messageStore.append({
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    from,
    content: 'Original exact-HEAD review carrier',
    mentions: ['codex'],
    origin: 'callback',
    timestamp: 100,
    deliveryStatus: 'queued',
  });
  const admitted = await invocationQueue.enqueueExistingMessageDurable(messageStore, message.id, {
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    from,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: message.content,
    messageId: message.id,
    targetCats: ['codex'],
    intent: 'execute',
    autoExecute: true,
    sourceCategory: 'a2a',
    actionSuccessorFence: fence,
  });
  if (state === 'interrupted') {
    const terminalized = await invocationQueue.terminalizeEntryDurable(
      lease.holderThreadId,
      lease.tenantScope,
      admitted.entry.id,
      'interrupted',
      'runtime_restart',
    );
    assert.ok(terminalized);
    assert.equal(invocationQueue.list(lease.holderThreadId, lease.tenantScope).length, 0);
  }
  return message;
}

describe('direct action carrier restart recovery', () => {
  let app;
  let messageStore;
  let invocationQueue;
  let source;
  let target;
  let auth;
  let lease;
  let unavailable;
  let registry;
  let queueDrainError;

  beforeEach(async () => {
    app = Fastify();
    messageStore = new MessageStore();
    invocationQueue = new InvocationQueue();
    const threadStore = new ThreadStore();
    registry = new InvocationRegistry();
    source = await threadStore.create('user-1', 'Author');
    target = await threadStore.create('user-1', 'Reviewer');
    auth = await registry.create('user-1', 'opus', source.id);
    lease = carrierLease(source.id, target.id);
    unavailable = [];
    queueDrainError = undefined;

    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      invocationQueue,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'child-invocation' }),
        update() {},
        get: () => null,
      },
      queueProcessor: {
        async requestDrain() {
          if (queueDrainError) throw queueDrainError;
        },
        async tryAutoExecute() {},
      },
      actionSuccessorAdmissionService: {
        async admit() {
          return { admit: false, outcome: 'safe_wait', lease };
        },
        async markUnavailable(input) {
          unavailable.push(input);
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(clientMessageId) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: 'Review exact HEAD',
        targetCats: ['codex'],
        clientMessageId,
        action,
      },
    });
  }

  test('keeps safe_wait when exact durable custody is live', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'live');
    const response = await post('review-4058-live-reentry');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    assert.equal(invocationQueue.list(target.id, 'user-1').length, 1);
  });

  test('reuses the original generation once after runtime interruption', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'interrupted');
    const response = await post('review-4058-recover-interrupted');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.deepEqual(response.json().actionLease, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      outcome: 'replayed',
    });
    const [replacement] = invocationQueue.list(target.id, 'user-1');
    assert.deepEqual(replacement.execution.actionSuccessorFence, buildActionSuccessorFence(lease, lease.dispatchId));
    assert.deepEqual(unavailable, []);

    const messageCount = messageStore.getByThreadIncludingQueued(target.id, 20, 'user-1').length;
    const laterReentry = await post('review-4058-after-recovery');
    assert.equal(laterReentry.json().status, 'safe_wait');
    assert.equal(messageStore.getByThreadIncludingQueued(target.id, 20, 'user-1').length, messageCount);
  });

  test('same-client retry observes an atomically admitted replacement carrier', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'interrupted');
    const clientMessageId = 'review-4058-crash-after-append';
    const fence = buildActionSuccessorFence(lease, lease.dispatchId);
    const replacement = await invocationQueue.appendAndEnqueueDurable(
      messageStore,
      {
        threadId: target.id,
        userId: 'user-1',
        from: { kind: 'agent', catId: 'opus' },
        content: 'Review exact HEAD',
        mentions: ['codex'],
        origin: 'callback',
        timestamp: 130,
        deliveryStatus: 'queued',
        idempotencyKey: `action-carrier-recovery:${lease.leaseId}:${lease.generation}`,
      },
      {
        threadId: target.id,
        userId: 'user-1',
        from: { kind: 'agent', catId: 'opus' },
        kind: 'message_wake',
        ownerAuthProvenance: 'strict',
        content: 'Review exact HEAD',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
        sourceCategory: 'a2a',
        actionSuccessorFence: fence,
      },
    );
    assert.equal(await registry.claimClientMessageId(auth.invocationId, clientMessageId), true);

    const response = await post(clientMessageId);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    const [queued] = invocationQueue.list(target.id, 'user-1');
    assert.equal(queued.payload.messageId, replacement.message.id);
    assert.deepEqual(queued.execution.actionSuccessorFence, fence);
  });

  test('503 names startup reconciliation instead of promising same-client retry delivery', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'interrupted');
    queueDrainError = new Error('simulated crash after durable admission');

    const response = await post('review-4058-admitted-uncommitted');

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      kind: 'action_carrier_recovery_pending',
      message:
        'The replacement carrier has durable Queue admission, but delivery is not committed. Runtime startup reconciliation is required to restore Queue delivery; retrying this clientMessageId only confirms the admission.',
      messageId: response.json().messageId,
      clientMessageId: 'review-4058-admitted-uncommitted',
    });
  });
});
