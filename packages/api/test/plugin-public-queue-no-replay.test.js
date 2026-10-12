import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { isPublicInvocationRetryForbidden } from '../src/domains/cats/services/stores/ports/public-invocation-queue-retry.ts';
import { assertQueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.ts';
import { projectQueueReceipt } from '../src/domains/cats/services/stores/ports/queued-message-receipt.ts';
import { resolveDurableRetryAttemptId } from '../src/utils/queue-enrichment.ts';

const sourceId = '0000000000001000-000001-00000001';
const child = 'exact-public-child';
const witnesses = ['attempt', 'exposure', 'seen', 'awakened'];

function fixture(witness = 'attempt', isPublic = true) {
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
    targetCatId: 'astra',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const entry = {
    id: 'entry',
    threadId: 'thread',
    userId: 'owner',
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'public input',
    messageId: sourceId,
    mergedMessageIds: [],
    targetCats: ['astra'],
    allTargetCats: ['astra'],
    intent: 'execute',
    autoExecute: true,
    status: 'queued',
    priority: 'normal',
    createdAt: 1000,
    ...(isPublic ? { pluginPublicInvocation: carrier } : {}),
    queuedFailedByCatIds: ['astra'],
    queuedFailureReasonByCatId: { astra: 'invocation_failed' },
  };
  const custody = createInitialQueuedMessageCustody(entry);
  custody.failedByCatIds = ['astra'];
  custody.updatedAt = 2000;
  const attempt = custody.targetAttempts[0];
  Object.assign(attempt, { state: 'failed', terminalReason: 'invocation_failed', updatedAt: 2000 });
  if (witness === 'attempt') attempt.invocationId = child;
  if (witness === 'exposure') {
    custody.bodyExposures = [{ targetCatId: 'astra', invocationId: child, seenAt: 1500 }];
    entry.queuedBodyExposures = structuredClone(custody.bodyExposures);
  }
  if (witness === 'seen') {
    custody.seenByCatIds = ['astra'];
    custody.seenInvocationIdByCatId = { astra: child };
    entry.queuedSeenByCatIds = ['astra'];
    entry.queuedSeenInvocationIdByCatId = { astra: child };
  }
  if (witness === 'awakened') {
    custody.awakenedInvocationIdByCatId = { astra: child };
    custody.awakenedAtByCatId = { astra: 1400 };
    entry.queuedAwakenedInvocationIdByCatId = { astra: child };
    entry.queuedAwakenedAtByCatId = { astra: 1400 };
  }
  assertQueuedMessageCustody(custody);
  const store = new MessageStore();
  store.append({
    reservedId: sourceId,
    threadId: entry.threadId,
    userId: entry.userId,
    catId: null,
    content: entry.content,
    source: { connector: 'fixture' },
    mentions: ['astra'],
    timestamp: 1000,
    deliveryStatus: 'queued',
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 } },
    queueCustody: custody,
  });
  const queue = new InvocationQueue();
  queue.restoreDurableEntry(entry);
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => 3000 });
  let authorityCalls = 0;
  const commit = async (transitions) => {
    authorityCalls++;
    for (const transition of transitions) {
      const result = store.transitionQueueCustody(transition.messageId, {
        expectedRevision: transition.current.revision,
        next: transition.next,
      });
      assert.equal(result.kind, 'updated');
    }
    return { outcome: 'committed' };
  };
  return { entry, custody, store, queue, coordinator, commit, authorityCalls: () => authorityCalls };
}

test('no replay control: all four legacy public witness shapes are valid stored custody', () => {
  for (const witness of witnesses) {
    const f = fixture(witness);
    assert.deepEqual(f.store.getById(sourceId).queueCustody, f.custody);
    assert.equal(f.custody.targetAttempts[0].state, 'failed');
    assert.equal(f.authorityCalls(), 0);
  }
});

test('no replay control: ordinary failed custody still appends an exact retry attempt', async () => {
  const f = fixture('attempt', false);
  const old = structuredClone(f.custody.targetAttempts[0]);
  const result = await f.coordinator.retryFailedTarget(f.entry, 'astra', old.id, f.commit);
  assert.equal(result.outcome, 'retried');
  assert.equal(f.authorityCalls(), 1);
  assert.deepEqual(f.store.getById(sourceId).queueCustody.targetAttempts[0], old);
  assert.equal(f.store.getById(sourceId).queueCustody.targetAttempts.length, 2);
});

test('no replay control: ordinary receipt and action resolver still expose retry', () => {
  const f = fixture('attempt', false);
  assert.notEqual(projectQueueReceipt(f.custody).targets[0].retryable, false);
  assert.equal(
    resolveDurableRetryAttemptId(f.entry, f.store.getById(sourceId), 'astra'),
    f.custody.targetAttempts[0].id,
  );
  assert.ok(f.queue.retryFailedTarget('thread', 'owner', 'entry', 'astra'));
});

for (const witness of witnesses) {
  test(`public ${witness} witness removes receipt retry even after legacy failure`, () => {
    const f = fixture(witness);
    const before = structuredClone(f.custody);
    assert.equal(projectQueueReceipt(f.custody).targets[0].retryable, false, 'public receipt must forbid replay');
    assert.deepEqual(f.custody, before);
  });
  test(`public ${witness} witness removes API retry action`, () => {
    const f = fixture(witness);
    assert.equal(
      resolveDurableRetryAttemptId(f.entry, f.store.getById(sourceId), 'astra'),
      undefined,
      'public retry action must be absent',
    );
  });
  test(`public ${witness} witness rejects durable retry before authority or custody mutation`, async () => {
    const f = fixture(witness);
    const before = f.store.getById(sourceId);
    const result = await f.coordinator.retryFailedTarget(f.entry, 'astra', f.custody.targetAttempts[0].id, f.commit);
    assert.equal(result.outcome, 'not_retryable', 'public durable retry must be rejected');
    assert.equal(f.authorityCalls(), 0);
    assert.deepEqual(f.store.getById(sourceId), before);
  });
}

for (const witness of ['seen', 'awakened', 'exposure', 'attempt']) {
  test(`public memory retry refuses ${witness} projection without clearing state`, () => {
    const f = fixture(witness);
    const before = f.queue.getEntrySnapshot('thread', 'owner', 'entry');
    assert.equal(
      f.queue.retryFailedTarget('thread', 'owner', 'entry', 'astra'),
      null,
      'public memory retry must fail closed even if active maps are absent',
    );
    assert.deepEqual(f.queue.getEntrySnapshot('thread', 'owner', 'entry'), before);
  });
}

for (const reason of ['public_output_abandoned', 'public_output_conflict']) {
  test(`${reason} is a valid failed public attempt reason`, () => {
    const f = fixture();
    f.custody.targetAttempts[0].terminalReason = reason;
    assert.doesNotThrow(() => assertQueuedMessageCustody(f.custody), 'public terminal reason must be accepted');
  });
  test(`${reason} alone removes receipt retry without relying on active binding`, () => {
    const f = fixture('none', false);
    f.custody.targetAttempts[0].terminalReason = reason;
    assert.equal(projectQueueReceipt(f.custody).targets[0].retryable, false, 'no replay reason must fence receipt');
  });
  test(`${reason} alone rejects memory retry without mutation`, () => {
    const f = fixture('none', false);
    const before = f.queue.getEntrySnapshot('thread', 'owner', 'entry');
    const next = structuredClone(before);
    next.queuedFailureReasonByCatId.astra = reason;
    assert.equal(f.queue.restoreEntrySnapshotIfUnchanged(before, next), true);
    assert.equal(
      f.queue.retryFailedTarget('thread', 'owner', 'entry', 'astra'),
      null,
      'no replay reason must fence memory retry',
    );
    assert.deepEqual(f.queue.getEntrySnapshot('thread', 'owner', 'entry'), next);
  });
}

test('legacy interrupted public attempt remains immutable and explicitly non-retryable in receipt', () => {
  const f = fixture();
  Object.assign(f.custody.targetAttempts[0], { state: 'interrupted', terminalReason: 'runtime_restart' });
  assertQueuedMessageCustody(f.custody);
  const before = structuredClone(f.custody);
  const receipt = projectQueueReceipt(f.custody).targets[0];
  assert.equal(receipt.state, 'interrupted');
  assert.equal(receipt.retryable, false, 'public interrupted receipt must forbid replay');
  assert.deepEqual(f.custody, before);
});

test('conflicting historical public child witnesses cannot produce a retry action', () => {
  const f = fixture();
  f.custody.bodyExposures = [{ targetCatId: 'astra', invocationId: 'other-child', seenAt: 1500 }];
  assertQueuedMessageCustody(f.custody);
  assert.equal(
    projectQueueReceipt(f.custody).targets[0].retryable,
    false,
    'conflicting public identity must forbid replay',
  );
});

test('conflicting durable public child witnesses cannot append a retry attempt', async () => {
  const f = fixture();
  const observed = f.store.getById(sourceId).queueCustody;
  const next = structuredClone(observed);
  next.revision++;
  next.bodyExposures = [{ targetCatId: 'astra', invocationId: 'other-child', seenAt: 1500 }];
  assert.equal(f.store.transitionQueueCustody(sourceId, { expectedRevision: observed.revision, next }).kind, 'updated');
  const before = f.store.getById(sourceId);
  const result = await f.coordinator.retryFailedTarget(f.entry, 'astra', observed.targetAttempts[0].id, f.commit);
  assert.equal(result.outcome, 'not_retryable', 'conflicting public identity must reject durable retry');
  assert.equal(f.authorityCalls(), 0);
  assert.deepEqual(f.store.getById(sourceId), before);
});

function retryTransition(current) {
  const next = structuredClone(current);
  next.revision++;
  next.updatedAt = 3000;
  next.failedByCatIds = [];
  next.seenByCatIds = [];
  next.seenInvocationIdByCatId = {};
  delete next.awakenedInvocationIdByCatId;
  delete next.awakenedAtByCatId;
  next.targetAttempts.push({
    id: 'entry:astra:2',
    targetCatId: 'astra',
    sequence: 2,
    state: 'queued',
    createdAt: 3000,
    updatedAt: 3000,
  });
  return { expectedRevision: current.revision, next };
}

for (const witness of witnesses) {
  test(`storage CAS independently rejects replay from public ${witness} history`, () => {
    const f = fixture(witness);
    const before = f.store.getById(sourceId);
    assert.throws(
      () => f.store.transitionQueueCustody(sourceId, retryTransition(before.queueCustody)),
      /cannot append a replay attempt/,
    );
    assert.deepEqual(f.store.getById(sourceId), before);
  });
}

test('stale ordinary retry CAS cannot overwrite a concurrently bound public source', () => {
  const f = fixture('none');
  const old = f.store.getById(sourceId).queueCustody;
  const stale = retryTransition(old);
  const next = structuredClone(old);
  next.revision++;
  next.awakenedInvocationIdByCatId = { astra: child };
  next.awakenedAtByCatId = { astra: 2000 };
  assert.equal(f.store.transitionQueueCustody(sourceId, { expectedRevision: old.revision, next }).kind, 'updated');
  const before = f.store.getById(sourceId);
  assert.equal(f.store.transitionQueueCustody(sourceId, stale).kind, 'revision_mismatch');
  stale.expectedRevision = next.revision;
  stale.next.revision = next.revision + 1;
  assert.throws(() => f.store.transitionQueueCustody(sourceId, stale), /cannot append a replay attempt/);
  assert.deepEqual(f.store.getById(sourceId), before);
});

for (const location of ['carrier', 'historical invocation']) {
  test(`retry identity rejects ${location} accessor without invoking it`, () => {
    const f = fixture();
    let calls = 0;
    const record = location === 'carrier' ? f.custody : f.custody.targetAttempts[0];
    const key = location === 'carrier' ? 'pluginPublicInvocation' : 'invocationId';
    Object.defineProperty(record, key, {
      enumerable: true,
      get() {
        calls++;
        return child;
      },
    });
    assert.equal(isPublicInvocationRetryForbidden(f.custody, 'astra'), true);
    assert.equal(calls, 0);
  });
}

test('generic Retry cannot substitute for public prelaunch admission even without a child', async () => {
  const f = fixture('none');
  assert.equal(isPublicInvocationRetryForbidden(f.custody, 'astra'), false);
  const before = f.store.getById(sourceId);
  const result = await f.coordinator.retryFailedTarget(f.entry, 'astra', f.custody.targetAttempts[0].id, f.commit);
  assert.equal(result.outcome, 'not_retryable');
  assert.equal(f.authorityCalls(), 0);
  assert.deepEqual(f.store.getById(sourceId), before);
  assert.equal(projectQueueReceipt(f.custody).targets[0].retryable, false);
  assert.equal(f.queue.retryFailedTarget('thread', 'owner', 'entry', 'astra'), null);
});

for (const isPublic of [true, false]) {
  test(`cancelled bound custody retry preserves public=${isPublic} contract`, async () => {
    const f = fixture('attempt', isPublic);
    const old = f.store.getById(sourceId);
    // Seed a valid immutable cancelled history, rather than rewriting an existing terminal attempt.
    const cancelled = structuredClone(old.queueCustody);
    Object.assign(cancelled.targetAttempts[0], { state: 'cancelled', terminalReason: 'invocation_cancelled' });
    const store = new MessageStore();
    store.append({
      reservedId: sourceId,
      threadId: 'thread',
      userId: 'owner',
      catId: null,
      content: 'public input',
      mentions: ['astra'],
      timestamp: 1000,
      deliveryStatus: 'queued',
      queueCustody: cancelled,
    });
    const owner = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => 3000 });
    let calls = 0;
    const result = await owner.retryFailedTarget(
      f.entry,
      'astra',
      cancelled.targetAttempts[0].id,
      async (transitions) => {
        calls++;
        for (const t of transitions)
          assert.equal(
            store.transitionQueueCustody(t.messageId, { expectedRevision: t.current.revision, next: t.next }).kind,
            'updated',
          );
        return { outcome: 'committed' };
      },
    );
    assert.equal(result.outcome, isPublic ? 'not_retryable' : 'retried');
    assert.equal(calls, isPublic ? 0 : 1);
    assert.deepEqual(store.getById(sourceId).queueCustody.targetAttempts[0], cancelled.targetAttempts[0]);
  });
}
