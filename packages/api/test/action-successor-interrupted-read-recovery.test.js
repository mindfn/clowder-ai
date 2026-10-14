/**
 * F167: refusal -> explicit recovery -> next generation, through the real callback route, admission service, lease
 * state machine (memory or isolated Redis), queued-message custody CAS and the startup reconciler.
 *
 * Adapted from codex61-sol's PR #5100 review reproduction: the refusal for an action interrupted after a holder read it
 * pointed the predecessor at an explicit replace that could never succeed (the lease stays active and replace required
 * `replaceable`). This file fails if the advertised recovery is not actually executable, and guards that nothing else
 * (a live generation, a request body) can unlock replacing an active generation.
 *
 * Runs against in-memory stores by default; under the isolated Redis runner it uses RedisActionSuccessorLeaseStore and
 * RedisMessageStore on a private key prefix.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { ActionSuccessorAdmissionService } from '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import {
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
} from '../dist/domains/ball-custody/action-successor-state-machine.js';
import { classifyDirectActionSuccessorCarrier } from '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { reconcileStartupCustodyMessage } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupMessageReconciler.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../dist/domains/cats/services/stores/ports/queued-message-receipt.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';

/** Which lease and message stores this run used; part of every test name so the evidence shows it. */
const BACKEND = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1' ? 'redis' : 'memory';

const ACTION = {
  subjectRef: 'subject:task:f167-interrupted-read-task',
  actionFamily: 'implement',
  successorSlot: 'implementer',
  mode: 'single',
  terminalPredicate: { kind: 'task_done' },
};

/** In-memory lease store built only from the production pure transitions. */
function memoryLeaseStore() {
  let current = null;
  return {
    async claim(input) {
      const result = claimActionSuccessor(current, input);
      current = result.lease;
      return result;
    },
    async get(id) {
      return current?.leaseId === id ? current : null;
    },
    async replace(id, input) {
      assert.equal(current.leaseId, id);
      const result = replaceActionSuccessor(current, input);
      current = result.lease;
      return result;
    },
    async commitOutcome(id, input) {
      assert.equal(current.leaseId, id);
      current = recordActionSuccessorOutcome(current, input);
      return { outcome: 'recorded', lease: current };
    },
    async refreshHandledCarrier() {
      throw new Error('not expected in this file');
    },
    async getSubjectTerminal() {
      return null;
    },
    current: () => current,
  };
}

/** The real Redis store, remembering the last lease it returned so assertions can read it. */
function redisLeaseStore(redis) {
  const real = new RedisActionSuccessorLeaseStore(redis);
  let last;
  const remember =
    (name) =>
    async (...args) => {
      const result = await real[name](...args);
      last = result.lease;
      return result;
    };
  return {
    current: () => last,
    get: async (id) => {
      last = await real.get(id);
      return last;
    },
    claim: remember('claim'),
    replace: remember('replace'),
    commitOutcome: remember('commitOutcome'),
    refreshHandledCarrier: (...args) => real.refreshHandledCarrier(...args),
    getSubjectTerminal: (...args) => real.getSubjectTerminal(...args),
  };
}

let app;
let store;
let messageStore;
let queue;
let registry;
let source;
let target;
let auth;
let currentAction;
let callerCat;
let redis;

beforeEach(async () => {
  currentAction = ACTION;
  callerCat = 'opus';
  redis = undefined;
  if (process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1') {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F167 interrupted-read recovery');
    redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f167-interrupted-read:${randomUUID()}:` });
    await redis.ping();
    store = redisLeaseStore(redis);
    messageStore = new RedisMessageStore(redis);
  } else {
    store = memoryLeaseStore();
    messageStore = new MessageStore();
  }
  queue = new InvocationQueue();
  registry = new InvocationRegistry();
  const threads = new ThreadStore();
  source = await threads.create('user-1', 'Predecessor thread');
  target = await threads.create('user-1', 'Holder thread');
  auth = await registry.create('user-1', 'opus', source.id);
  const admission = new ActionSuccessorAdmissionService(store, {
    async resolve() {
      return { terminal: false, source: 'task', state: 'active' };
    },
    async resolveFreshness(predicate) {
      return {
        status: 'verified',
        evidenceRef: 'task:f167-interrupted-read-task:active:1',
        freshnessKey: predicate.freshnessKey,
        ownerCatId: 'codex',
        holderThreadId: target.id,
        tenantScope: 'user-1',
      };
    },
  });
  app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore: threads,
    invocationQueue: queue,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: { async *routeExecution() {}, getExecutions: () => [] },
    invocationRecordStore: {
      create: () => ({ outcome: 'created', invocationId: 'test-parent' }),
      update() {},
      get: () => null,
    },
    queueProcessor: { async tryAutoExecute() {} },
    actionSuccessorAdmissionService: admission,
    actionSuccessorLeaseStore: store,
  });
});

afterEach(async () => {
  await app.close();
  if (redis) await redis.quit();
});

function post(clientMessageId, overrides = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    payload: {
      threadId: target.id,
      content: 'Implement the accepted task',
      targetCats: ['codex'],
      clientMessageId,
      action: currentAction,
      ...overrides,
    },
  });
}

function replaceAction(lease) {
  return { action: { ...ACTION, replace: { leaseId: lease.leaseId, expectedGeneration: lease.generation } } };
}

/** Dispatch once, then put the carrier through a real restart with (or without) a recorded read of the action. */
async function interruptedCarrier({ read }) {
  const first = await post('f167-first');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'ok', first.body);
  const id = first.json().messageId;
  let message = await messageStore.getById(id);
  const custody = message.queueCustody;
  const now = Date.now();
  const next = structuredClone(custody);
  next.revision++;
  next.status = 'processing';
  next.updatedAt = now;
  next.pendingTargetCats = ['codex'];
  next.awakenedInvocationIdByCatId = { codex: 'old-child' };
  next.awakenedAtByCatId = { codex: now - 10 };
  if (read) {
    next.seenByCatIds = ['codex'];
    next.seenInvocationIdByCatId = { codex: 'old-child' };
    next.bodyExposures = [{ targetCatId: 'codex', invocationId: 'old-child', seenAt: now - 5 }];
    next.targetAttempts[0] = {
      ...next.targetAttempts[0],
      state: 'appended',
      invocationId: 'old-child',
      seenAt: now - 5,
      updatedAt: now,
    };
  } else {
    next.targetAttempts[0] = {
      ...next.targetAttempts[0],
      state: 'starting',
      invocationId: 'old-child',
      updatedAt: now,
    };
  }
  const changed = await messageStore.transitionQueueCustody(id, { expectedRevision: custody.revision, next });
  assert.equal(changed.kind, 'updated');
  const reconciled = await reconcileStartupCustodyMessage(
    {
      messageStore,
      invocationQueue: new InvocationQueue(),
      invocationRecordStore: { get: () => null },
      turnExecutionStore: { get: () => null },
      a2aDispatchDispositionService: { inspectHandoff: async () => ({ outcome: 'active' }) },
      log: { info() {}, warn() {} },
    },
    id,
    Date.now,
  );
  assert.ok(reconciled);
  message = await messageStore.getById(id);
  assert.equal(projectQueueReceipt(message.queueCustody).targets[0].state, 'interrupted');
  const lease = await store.get(first.json().actionLease.leaseId);
  const decision = classifyDirectActionSuccessorCarrier(lease, [message]);
  if (read) assert.equal(decision.reason, 'interrupted_after_read');
  else assert.equal(decision.disposition, 'restart_interrupted');
  // The restarted process starts with an empty in-memory queue.
  queue.remove(target.id, 'user-1', queue.list(target.id, 'user-1')[0].id);
  auth = await registry.create('user-1', callerCat, source.id);
  return { message, lease };
}

test(`[${BACKEND}] the refusal’s explicit replace moves the qualified predecessor to the next generation`, async () => {
  const old = await interruptedCarrier({ read: true });

  const refused = await post('f167-resend');
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().reason, 'interrupted_after_read');

  const recovered = await post('f167-explicit-replace', replaceAction(old.lease));
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().status, 'ok', recovered.body);
  assert.equal(recovered.json().actionLease.outcome, 'replaced');
  assert.equal(recovered.json().actionLease.generation, old.lease.generation + 1);
  assert.equal(queue.list(target.id, 'user-1').length, 1, 'exactly one carrier for the new generation');
  const lease = await store.get(old.lease.leaseId);
  assert.equal(lease.status, 'active');
  assert.deepEqual(lease.holderOutcomes, {}, 'no outcome is invented for the interrupted holder');
  assert.ok(
    lease.evidenceRefs.some((ref) => ref.startsWith(`carrier-interrupted-after-read:${old.lease.leaseId}:g1:`)),
    'the interruption that allowed the replace is on record',
  );
});

test(`[${BACKEND}] re-sending after a recorded read is refused and changes neither the lease nor the queue`, async () => {
  const old = await interruptedCarrier({ read: true });
  const retry = await post('f167-refused');
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.json().reason, 'interrupted_after_read');
  assert.deepEqual(await store.get(old.lease.leaseId), old.lease);
  assert.equal(queue.list(target.id, 'user-1').length, 0);
});

test(`[${BACKEND}] an awakened-only interruption is still replayed on the same generation`, async () => {
  const old = await interruptedCarrier({ read: false });
  const retry = await post('f167-unread');
  assert.equal(retry.json().status, 'ok', retry.body);
  assert.equal(retry.json().actionLease.outcome, 'replayed');
  assert.equal(retry.json().actionLease.generation, old.lease.generation);
  assert.equal(queue.list(target.id, 'user-1').length, 1);
});

test(`[${BACKEND}] replacing a live, never-interrupted generation still needs ordinary proof`, async () => {
  const first = await post('f167-live');
  assert.equal(first.json().status, 'ok', first.body);
  const lease = await store.get(first.json().actionLease.leaseId);
  auth = await registry.create('user-1', callerCat, source.id);

  const replace = await post('f167-live-replace', replaceAction(lease));
  assert.equal(replace.json().status, 'proof_required', replace.body);
  assert.equal((await store.get(lease.leaseId)).generation, lease.generation);
});

test(`[${BACKEND}] a request body cannot supply the interruption proof`, async () => {
  const first = await post('f167-forged');
  assert.equal(first.json().status, 'ok', first.body);
  const lease = await store.get(first.json().actionLease.leaseId);
  auth = await registry.create('user-1', callerCat, source.id);
  const forged = { leaseId: lease.leaseId, generation: lease.generation, evidenceRef: 'forged' };

  const replace = await post('f167-forged-replace', {
    ...replaceAction(lease),
    interruptedGenerationEvidence: forged,
  });
  assert.notEqual(replace.json().status, 'ok', replace.body);
  assert.equal((await store.get(lease.leaseId)).generation, lease.generation);
});

test(`[${BACKEND}] an existing-standing resend after the interruption is deduplicated, not re-enqueued`, async () => {
  source = target;
  callerCat = 'codex';
  auth = await registry.create('user-1', callerCat, source.id);
  currentAction = {
    ...ACTION,
    claimOrigin: 'existing_standing',
    groundingEvidenceRef: 'task:f167-interrupted-read-task:accepted',
  };
  await interruptedCarrier({ read: true });
  const retry = await post('f167-first');
  assert.equal(retry.json().status, 'duplicate');
  assert.equal(queue.list(target.id, 'user-1').length, 0);
});
