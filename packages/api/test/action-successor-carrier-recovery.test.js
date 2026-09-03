import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  classifyDirectActionSuccessorCarrier,
  isExactDirectActionSuccessorReentry,
  resolveDirectActionSuccessorCarrier,
} from '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import { reconcileActionSuccessorEnqueue } from '../dist/domains/ball-custody/reconcile-action-successor-enqueue.js';

const terminalPredicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#4058',
  predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
});

function lease(overrides = {}) {
  return {
    leaseId: 'lease-review-4058',
    key: 'user-1|pr:owner/repo#4058|review|reviewer',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#4058',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['opus5'],
    dispatchId: 'cross-post:review-4058-old',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'callback:old-invocation:review-4058-old',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate,
    evidenceRefs: ['callback:old-invocation:review-4058-old'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    tenantScope: 'user-1',
    actorCatId: 'codex-sol',
    sourceThreadId: 'thread-author',
    targetThreadId: 'thread-review',
    holderCatIds: ['opus5'],
    dispatchId: 'cross-post:review-4058-reentry',
    evidenceRef: 'callback:new-invocation:review-4058-reentry',
    now: 200,
    action: {
      subjectRef: 'pr:owner/repo#4058',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    },
    ...overrides,
  };
}

function ledgerEntryForTarget(targetCatId, state, overrides = {}) {
  const currentLease = overrides.lease ?? lease({ holderCatIds: [targetCatId] });
  const fence = overrides.fence ?? buildActionSuccessorFence(currentLease, currentLease.dispatchId);
  const terminal = ['interrupted', 'handled', 'withdrawn', 'failed'].includes(state);
  const delivery = {};
  if (state === 'notified') delivery.notifiedAt = 110;
  if (state === 'awakened') {
    delivery.awakenedInvocationId = `invocation-${targetCatId}`;
    delivery.awakenedAt = 110;
  }
  if (state === 'seen') {
    delivery.awakenedInvocationId = `invocation-${targetCatId}`;
    delivery.awakenedAt = 110;
    delivery.seenInvocationId = `invocation-${targetCatId}`;
    delivery.seenAt = 115;
  }
  if (state === 'steering') delivery.steerRequestedAt = 115;
  if (terminal) {
    delivery.terminalOutcome = state;
    if (state === 'handled') delivery.handledAt = 120;
    else delivery.failedAt = 120;
    if (state === 'interrupted') delivery.failureReason = 'runtime_restart';
    if (state === 'failed') delivery.failureReason = 'invocation_failed';
  }
  return {
    version: 1,
    id: overrides.id ?? `entry-${targetCatId}-${state}`,
    threadId: currentLease.holderThreadId,
    owner: { kind: 'user', userId: currentLease.tenantScope },
    kind: 'conversation_input',
    from: { kind: 'agent', catId: currentLease.predecessorCatId },
    target: { kind: 'cat', catId: targetCatId },
    payload: {
      sourceId: overrides.id ?? `message-${targetCatId}-${state}`,
      content: 'Review exact HEAD',
      messageId: overrides.id ?? `message-${targetCatId}-${state}`,
    },
    execution: { intent: 'review', ownerAuthProvenance: 'strict', autoExecute: true, actionSuccessorFence: fence },
    delivery,
    status: terminal ? 'terminal' : 'queued',
    enqueuedAt: 100,
    ...(terminal ? { terminalAt: 120 } : {}),
    priority: 'normal',
    sourceCategory: 'a2a',
  };
}

describe('direct action successor carrier recovery', () => {
  test('keeps safe_wait only when every exact-fence holder has live durable custody', () => {
    const current = lease();
    for (const state of ['queued', 'notified', 'awakened', 'seen', 'steering']) {
      assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [ledgerEntryForTarget('opus5', state)]), {
        disposition: 'live',
        fence: buildActionSuccessorFence(current, current.dispatchId),
      });
    }
  });

  test('recognizes a complete pre-CAS admission as live durable custody', () => {
    const current = lease();
    const fence = buildActionSuccessorFence(current, current.dispatchId);
    const admission = ledgerEntryForTarget('opus5', 'queued', { id: 'message-admission', fence });

    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [admission]), {
      disposition: 'live',
      fence,
    });
  });

  test('recovers only when every exact holder carrier was interrupted by runtime restart', () => {
    const current = lease();
    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [ledgerEntryForTarget('opus5', 'interrupted')]), {
      disposition: 'restart_interrupted',
      fence: buildActionSuccessorFence(current, current.dispatchId),
    });
  });

  test('fails closed for missing, terminal, failed, mixed, or wrong-fence custody', () => {
    const single = lease();
    assert.equal(classifyDirectActionSuccessorCarrier(single, []).disposition, 'unavailable');
    for (const state of ['handled', 'withdrawn', 'failed']) {
      assert.equal(
        classifyDirectActionSuccessorCarrier(single, [ledgerEntryForTarget('opus5', state)]).disposition,
        'unavailable',
      );
    }

    const parallel = lease({ mode: 'parallel', holderCatIds: ['opus5', 'kimi'], parallelIntent: 'independent review' });
    assert.equal(
      classifyDirectActionSuccessorCarrier(parallel, [
        ledgerEntryForTarget('opus5', 'interrupted', { lease: parallel }),
        ledgerEntryForTarget('kimi', 'queued', { lease: parallel }),
      ]).disposition,
      'unavailable',
    );
    assert.equal(
      classifyDirectActionSuccessorCarrier(single, [
        ledgerEntryForTarget('opus5', 'interrupted', {
          fence: { ...buildActionSuccessorFence(single, single.dispatchId), generation: 2 },
        }),
      ]).disposition,
      'unavailable',
    );
  });

  test('requires exact request authority before reusing an interrupted fence', () => {
    const current = lease();
    assert.equal(isExactDirectActionSuccessorReentry(current, request()), true);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ actorCatId: 'opus' })), false);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ targetThreadId: 'thread-other' })), false);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ holderCatIds: ['kimi'] })), false);
    assert.equal(
      isExactDirectActionSuccessorReentry(
        current,
        request({
          action: {
            ...request().action,
            terminalPredicate: { kind: 'review_delivered', headSha: 'b'.repeat(40) },
          },
        }),
      ),
      false,
    );
  });

  test('turns custody lookup failure into an explicit fail-closed decision', async () => {
    const decision = await resolveDirectActionSuccessorCarrier({
      lease: lease(),
      admissionInput: request(),
      invocationQueue: {
        async listAllDurable() {
          throw new Error('store unavailable');
        },
      },
    });
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'lookup_failed' });
  });

  test('does not settle an existing generation unavailable when replacement enqueue must retry', async () => {
    const unavailable = [];
    const current = lease();
    await reconcileActionSuccessorEnqueue({
      service: {
        async markUnavailable(input) {
          unavailable.push(input);
        },
        async markReturnedDelivered() {},
      },
      fence: buildActionSuccessorFence(current, current.dispatchId),
      disposition: 'successor_dispatch',
      admissionOutcome: 'replayed',
      unavailableCatIds: ['opus5'],
      now: 300,
    });
    assert.deepEqual(unavailable, []);
  });
});
