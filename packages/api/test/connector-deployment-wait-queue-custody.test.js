import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { QueueSourceCustodyAdmissionService } from '../dist/domains/cats/services/agents/invocation/QueueSourceCustodyAdmission.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { QueueSourceMutationWatchRegistry } from '../dist/domains/cats/services/stores/queue-source-mutation-watch.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';

function noOpLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: noOpLog,
  };
}

function createBusyThreadTrigger(messages, queue) {
  return new ConnectorInvokeTrigger({
    router: {
      async *routeExecution() {
        throw new Error('busy-thread connector must not start a direct route');
      },
    },
    socketManager: {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    },
    invocationRecordStore: {},
    invocationTracker: {},
    invocationQueue: queue,
    queueProcessor: { isThreadBusy: () => true, tryAutoExecute: async () => {} },
    messageStore: messages,
    log: noOpLog(),
  });
}

test('busy deployment-wait wake gains durable Queue custody before full-context exposure', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-deployment-owner',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_000,
    source: {
      connector: 'deployment-wait',
      label: 'Deployment Wait',
      icon: 'refresh-cw',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'task-deployment-owner',
          outcomeId: 'wait:deployment:runtime:g2:matched',
          ownerFence: { kind: 'containing_task', generation: 2 },
        },
      },
    },
  });
  assert.equal(source.deliveryStatus, undefined, 'connector publication starts as an ordinary timeline message');

  const trigger = createBusyThreadTrigger(messages, queue);
  const args = [
    source.threadId,
    'codex-astra',
    source.userId,
    source.content,
    source.id,
    undefined,
    {
      reason: 'deployment_wait_satisfied',
      coalesceKey: 'deployment:runtime:wait:codex-astra',
    },
  ];

  assert.deepEqual(await Promise.all([trigger.trigger(...args), trigger.trigger(...args)]), ['enqueued', 'enqueued']);

  const [entry] = queue.list(source.threadId, source.userId);
  assert.ok(entry);
  assert.equal(queue.list(source.threadId, source.userId).length, 1, 'replay reuses one in-memory carrier');
  const persisted = messages.getById(source.id);
  assert.equal(persisted?.deliveryStatus, 'queued');
  assert.equal(persisted?.queueCustody?.entryId, entry.id);
  assert.deepEqual(persisted?.queueCustody?.pendingTargetCats, ['codex-astra']);

  const readerInvocationId = 'invocation-reading-deployment-wake';
  const exposureAt = Date.now() + 100;
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, entry.id, 'codex-astra', readerInvocationId, exposureAt),
    true,
  );
  const exposed = queue.getEntrySnapshot(source.threadId, source.userId, entry.id);
  assert.ok(exposed);
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages, now: () => exposureAt });
  assert.deepEqual(await coordinator.persistEntry(exposed), [source.id]);
  await coordinator.assertPromptExposurePersisted([source.id], 'codex-astra', readerInvocationId);
});

test('pending connector custody admission is invisible and refusal removes the unpublished carrier', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-pending-admission-refusal',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_250,
  });
  const selectorObservations = [];
  queue.onSourceChanged(() => {
    selectorObservations.push(queue.listAutoExecute(source.threadId).map((entry) => entry.id));
  });
  let enteredAdmission;
  const entered = new Promise((resolve) => {
    enteredAdmission = resolve;
  });
  let resolveAdmission;
  messages.admitQueueCustody = () => {
    enteredAdmission();
    return new Promise((resolve) => {
      resolveAdmission = resolve;
    });
  };

  const outcome = createBusyThreadTrigger(messages, queue)
    .trigger(source.threadId, 'codex-astra', source.userId, source.content, source.id, undefined, {
      forceQueue: true,
    })
    .then(
      () => null,
      (error) => error,
    );
  await entered;
  const [pending] = queue.list(source.threadId, source.userId);
  assert.ok(pending);
  assert.deepEqual(
    selectorObservations,
    [],
    'enqueue must install the admission fence before notifying ordinary Queue readers',
  );
  assert.deepEqual(queue.listAutoExecute(source.threadId), []);
  assert.deepEqual(queue.getQueuedBodyMessagesForCat(source.threadId, source.userId, 'codex-astra'), []);
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, pending.id, 'codex-astra', 'reader-before-cas'),
    false,
  );

  resolveAdmission({ kind: 'conflict' });
  const error = await outcome;
  assert.match(error?.message ?? '', /Queue source custody admission failed .*: conflict/);
  assert.deepEqual(queue.list(source.threadId, source.userId), []);
});

test('concurrent coalesced connector sources wait behind one carrier admission without leaking an unbound merge', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const first = messages.append({
    threadId: 'thread-concurrent-coalesced-admission',
    userId: 'user-1',
    catId: null,
    content: 'First review signal',
    mentions: ['codex-astra'],
    timestamp: 1_260,
  });
  const second = messages.append({
    threadId: first.threadId,
    userId: first.userId,
    catId: null,
    content: 'Second review signal',
    mentions: ['codex-astra'],
    timestamp: 1_261,
  });
  const admitQueueCustody = messages.admitQueueCustody.bind(messages);
  let enteredFirstAdmission;
  const entered = new Promise((resolve) => {
    enteredFirstAdmission = resolve;
  });
  let releaseFirstAdmission;
  const released = new Promise((resolve) => {
    releaseFirstAdmission = resolve;
  });
  messages.admitQueueCustody = async (messageId, custody) => {
    if (messageId === first.id) {
      enteredFirstAdmission();
      await released;
    }
    return admitQueueCustody(messageId, custody);
  };
  const trigger = createBusyThreadTrigger(messages, queue);
  const policy = { reason: 'github_review_feedback', coalesceKey: 'pr:owner/repo#42:review-feedback' };

  const firstOutcome = trigger.trigger(
    first.threadId,
    'codex-astra',
    first.userId,
    first.content,
    first.id,
    undefined,
    policy,
  );
  await entered;
  const secondOutcome = trigger.trigger(
    second.threadId,
    'codex-astra',
    second.userId,
    second.content,
    second.id,
    undefined,
    policy,
  );
  await new Promise((resolve) => setImmediate(resolve));

  const [pending] = queue.list(first.threadId, first.userId);
  assert.ok(pending);
  assert.deepEqual(
    pending.mergedMessageIds,
    [],
    'the second source must not mutate a carrier owned by an unresolved first admission',
  );
  releaseFirstAdmission();
  assert.deepEqual(await Promise.all([firstOutcome, secondOutcome]), ['enqueued', 'enqueued']);

  const [published] = queue.list(first.threadId, first.userId);
  assert.ok(published);
  assert.deepEqual(published.mergedMessageIds, [second.id]);
  assert.equal(published.queueCustodyAdmissionId, undefined);
  assert.equal(messages.getById(first.id)?.queueCustody?.entryId, published.id);
  assert.equal(messages.getById(second.id)?.queueCustody?.entryId, published.id);
});

test('a later coalesced connector source requires a body exposure recorded after that source joined the carrier', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const first = messages.append({
    threadId: 'thread-coalesced-exposure-boundary',
    userId: 'user-1',
    catId: null,
    content: 'First review signal',
    mentions: ['codex-astra'],
    timestamp: 1_270,
  });
  const second = messages.append({
    threadId: first.threadId,
    userId: first.userId,
    catId: null,
    content: 'Second review signal',
    mentions: ['codex-astra'],
    timestamp: 1_271,
  });
  const trigger = createBusyThreadTrigger(messages, queue);
  const policy = { reason: 'github_review_feedback', coalesceKey: 'pr:owner/repo#43:review-feedback' };
  assert.equal(
    await trigger.trigger(first.threadId, 'codex-astra', first.userId, first.content, first.id, undefined, policy),
    'enqueued',
  );
  const [initial] = queue.list(first.threadId, first.userId);
  assert.ok(initial);
  const invocationId = 'coalesced-exposure-reader';
  assert.equal(
    queue.markQueuedSeen(first.threadId, first.userId, initial.id, 'codex-astra', invocationId, 1_280),
    true,
  );
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  await coordinator.persistEntry(queue.getEntrySnapshot(first.threadId, first.userId, initial.id));

  assert.equal(
    await trigger.trigger(second.threadId, 'codex-astra', second.userId, second.content, second.id, undefined, policy),
    'enqueued',
  );
  const [coalesced] = queue.list(first.threadId, first.userId);
  assert.ok(coalesced);
  assert.deepEqual(messages.getById(second.id)?.queueCustody?.bodyExposures ?? [], []);
  assert.deepEqual(coalesced.queuedBodyExposures ?? [], []);
  assert.equal(
    queue.markQueuedSeen(first.threadId, first.userId, coalesced.id, 'codex-astra', invocationId, 1_290),
    true,
  );
  await coordinator.persistEntry(queue.getEntrySnapshot(first.threadId, first.userId, coalesced.id));
  assert.deepEqual(messages.getById(first.id)?.queueCustody?.bodyExposures, [
    { targetCatId: 'codex-astra', invocationId, seenAt: 1_280 },
  ]);
  assert.deepEqual(messages.getById(second.id)?.queueCustody?.bodyExposures, [
    { targetCatId: 'codex-astra', invocationId, seenAt: 1_290 },
  ]);
});

test('successful connector custody admission releases the exact carrier after the durable CAS', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-pending-admission-success',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_300,
  });
  const admitQueueCustody = messages.admitQueueCustody.bind(messages);
  let enteredAdmission;
  const entered = new Promise((resolve) => {
    enteredAdmission = resolve;
  });
  let releaseAdmission;
  const released = new Promise((resolve) => {
    releaseAdmission = resolve;
  });
  messages.admitQueueCustody = async (messageId, custody) => {
    enteredAdmission();
    await released;
    return admitQueueCustody(messageId, custody);
  };

  const outcome = createBusyThreadTrigger(messages, queue).trigger(
    source.threadId,
    'codex-astra',
    source.userId,
    source.content,
    source.id,
    undefined,
    { forceQueue: true },
  );
  await entered;
  const [pending] = queue.list(source.threadId, source.userId);
  assert.ok(pending);
  assert.deepEqual(queue.listAutoExecute(source.threadId), []);
  assert.deepEqual(queue.getQueuedBodyMessagesForCat(source.threadId, source.userId, 'codex-astra'), []);

  releaseAdmission();
  assert.equal(await outcome, 'enqueued');
  assert.deepEqual(
    queue.listAutoExecute(source.threadId).map((entry) => entry.id),
    [pending.id],
  );
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, pending.id, 'codex-astra', 'reader-after-cas'),
    true,
  );
});

test('exact persisted connector replay stays idempotent while its carrier is processing', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-processing-replay',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_400,
  });
  const trigger = createBusyThreadTrigger(messages, queue);
  const args = [source.threadId, 'codex-astra', source.userId, source.content, source.id];

  assert.equal(await trigger.trigger(...args), 'enqueued');
  const [carrier] = queue.list(source.threadId, source.userId);
  assert.ok(carrier);
  assert.equal(queue.markProcessingById(source.threadId, carrier.id, 'codex-astra'), true);
  const custodyBeforeReplay = structuredClone(messages.getById(source.id)?.queueCustody);

  assert.equal(await trigger.trigger(...args), 'enqueued');
  assert.deepEqual(messages.getById(source.id)?.queueCustody, custodyBeforeReplay);
  assert.equal(queue.getEntrySnapshot(source.threadId, source.userId, carrier.id)?.status, 'processing');
  assert.equal(queue.list(source.threadId, source.userId).length, 1);
});

test('an older reader completion cannot consume a carrier during custody repair', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-completion-racing-repair',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_450,
  });
  const entry = queue.enqueue({
    threadId: source.threadId,
    userId: source.userId,
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    targetCats: ['codex-astra'],
    messageId: source.id,
    content: source.content,
    intent: 'execute',
    autoExecute: true,
    priority: 'normal',
  }).entry;
  assert.ok(entry);
  const readerInvocationId = 'reader-before-custody-repair';
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, entry.id, 'codex-astra', readerInvocationId, 1_451),
    true,
  );

  const admitQueueCustody = messages.admitQueueCustody.bind(messages);
  let enteredAdmission;
  const entered = new Promise((resolve) => {
    enteredAdmission = resolve;
  });
  let releaseAdmission;
  const released = new Promise((resolve) => {
    releaseAdmission = resolve;
  });
  messages.admitQueueCustody = async (...args) => {
    enteredAdmission();
    await released;
    return admitQueueCustody(...args);
  };
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const admissionService = new QueueSourceCustodyAdmissionService({
    queue,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
  });
  const admission = admissionService.admitDeferred(
    queue.getEntrySnapshot(source.threadId, source.userId, entry.id),
    source.id,
    true,
  );
  await entered;
  assert.ok(queue.getEntrySnapshot(source.threadId, source.userId, entry.id)?.queueCustodyAdmissionId);
  assert.deepEqual(
    queue.markQueuedFailedForCatAcrossUsers(source.threadId, 'codex-astra', readerInvocationId, new Set([entry.id])),
    [],
    'an older failed completion must not mutate an admission-owned carrier either',
  );

  const processor = new QueueProcessor({
    queue,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    invocationTracker: {},
    invocationRecordStore: {},
    router: {},
    log: noOpLog(),
    socketManager: {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    },
  });
  await processor.markQueuedHandledOnSuccess(source.threadId, 'codex-astra', readerInvocationId);
  releaseAdmission();
  await admission;

  assert.equal(queue.list(source.threadId, source.userId).length, 1);
  assert.equal(messages.getById(source.id)?.queueCustody?.entryId, entry.id);
});

test('late terminal rollback cannot resurrect a carrier replaced by exact source recovery', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-late-terminal-restore',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_475,
  });
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const queueSourceCustodyAdmission = new QueueSourceCustodyAdmissionService({
    queue,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
  });
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
  const trigger = new ConnectorInvokeTrigger({
    router: {
      async *routeExecution() {
        throw new Error('busy-thread connector must not start a direct route');
      },
    },
    socketManager,
    invocationRecordStore: {},
    invocationTracker: {},
    invocationQueue: queue,
    queueProcessor: { isThreadBusy: () => true },
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    queueSourceCustodyAdmission,
    log: noOpLog(),
  });
  const args = [source.threadId, 'codex-astra', source.userId, source.content, source.id];
  assert.equal(await trigger.trigger(...args), 'enqueued');
  const [oldCarrier] = queue.list(source.threadId, source.userId);
  assert.ok(oldCarrier);
  const readerInvocationId = 'old-reader-finishing';
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, oldCarrier.id, 'codex-astra', readerInvocationId, 1_476),
    true,
  );
  await coordinator.persistEntry(queue.getEntrySnapshot(source.threadId, source.userId, oldCarrier.id));

  let enteredLookup;
  const lookupEntered = new Promise((resolve) => {
    enteredLookup = resolve;
  });
  let releaseLookup;
  const lookupReleased = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  let intercepted = false;
  const getById = messages.getById.bind(messages);
  messages.getById = async (messageId) => {
    if (
      messageId === source.id &&
      !intercepted &&
      !queue.getEntrySnapshot(source.threadId, source.userId, oldCarrier.id)
    ) {
      intercepted = true;
      enteredLookup();
      await lookupReleased;
    }
    return getById(messageId);
  };
  const processor = new QueueProcessor({
    queue,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    queueSourceCustodyAdmission,
    invocationTracker: {},
    invocationRecordStore: {},
    router: {},
    socketManager,
    log: noOpLog(),
  });
  const terminal = processor.markQueuedHandledOnSuccess(source.threadId, 'codex-astra', readerInvocationId);
  await lookupEntered;
  assert.equal(queue.list(source.threadId, source.userId).length, 0);

  assert.equal(await trigger.trigger(...args), 'enqueued');
  const [replacement] = queue.list(source.threadId, source.userId);
  assert.ok(replacement);
  assert.notEqual(replacement.id, oldCarrier.id);
  releaseLookup();
  await terminal;

  assert.deepEqual(
    queue.list(source.threadId, source.userId).map((entry) => entry.id),
    [replacement.id],
  );
  assert.equal(getById(source.id)?.queueCustody?.entryId, replacement.id);
});

test('late terminal rollback cannot resurrect a source durably canceled before settlement', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-canceled-before-settlement',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 1_480,
  });
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
  const trigger = new ConnectorInvokeTrigger({
    router: {
      async *routeExecution() {
        throw new Error('busy-thread connector must not start a direct route');
      },
    },
    socketManager,
    invocationRecordStore: {},
    invocationTracker: {},
    invocationQueue: queue,
    queueProcessor: { isThreadBusy: () => true, tryAutoExecute: async () => false },
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    log: noOpLog(),
  });
  assert.equal(
    await trigger.trigger(source.threadId, 'codex-astra', source.userId, source.content, source.id, undefined, {
      forceQueue: true,
    }),
    'enqueued',
  );
  const [entry] = queue.list(source.threadId, source.userId);
  assert.ok(entry);
  const readerInvocationId = 'terminal-reader-canceled-before-settlement';
  assert.equal(
    queue.markQueuedSeen(source.threadId, source.userId, entry.id, 'codex-astra', readerInvocationId, 1_481),
    true,
  );
  await coordinator.persistEntry(queue.getEntrySnapshot(source.threadId, source.userId, entry.id));

  let enteredCommit;
  const commitEntered = new Promise((resolve) => {
    enteredCommit = resolve;
  });
  let releaseCommit;
  const commitReleased = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const commitSuccessfulTargetsForMessages = coordinator.commitSuccessfulTargetsForMessages.bind(coordinator);
  coordinator.commitSuccessfulTargetsForMessages = async (...args) => {
    enteredCommit();
    await commitReleased;
    return commitSuccessfulTargetsForMessages(...args);
  };
  const processor = new QueueProcessor({
    queue,
    messageStore: messages,
    queueCustodyCoordinator: coordinator,
    invocationTracker: {},
    invocationRecordStore: {},
    router: {},
    socketManager,
    log: noOpLog(),
  });
  const terminal = processor.markQueuedHandledOnSuccess(source.threadId, 'codex-astra', readerInvocationId);
  await commitEntered;
  assert.deepEqual(queue.list(source.threadId, source.userId), []);

  assert.equal(messages.markCanceled(source.id)?.deliveryTransitioned, true);
  assert.equal(messages.getById(source.id)?.deliveryStatus, 'canceled');
  assert.equal(messages.getById(source.id)?.queueCustody, undefined);
  releaseCommit();
  await terminal;

  assert.deepEqual(queue.list(source.threadId, source.userId), []);
  assert.deepEqual(queue.listAutoExecute(source.threadId), []);
});

test('a restore watch waits for every overlapping source mutation before a fresh read', async () => {
  const watches = new QueueSourceMutationWatchRegistry();
  const finishFirst = watches.beginMutation('source-1');
  const watch = watches.watch(['source-1']);
  assert.equal(watch.isCurrent(), false);

  let settled = false;
  const settlement = watch.waitForSettled().then(() => {
    settled = true;
  });
  const finishSecond = watches.beginMutation('source-1');
  finishFirst();
  await Promise.resolve();
  assert.equal(settled, false);

  finishSecond();
  await settlement;
  assert.equal(settled, true);
  assert.equal(watch.isCurrent(), false, 'a stale watch must force a new source read after settlement');
  watch.release();

  const fresh = watches.watch(['source-1']);
  assert.equal(fresh.isCurrent(), true);
  fresh.release();
});

for (const coalesced of [false, true]) {
  test(`managed rollback revalidates a source canceled during its lookup (coalesced=${coalesced})`, async () => {
    const messages = new MessageStore();
    const queue = new InvocationQueue();
    const source = messages.append({
      threadId: `thread-canceled-during-restore-${coalesced}`,
      userId: 'user-1',
      catId: null,
      content: 'Deployment ready',
      mentions: ['codex-astra'],
      timestamp: 1_482,
    });
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
    const trigger = new ConnectorInvokeTrigger({
      router: {
        async *routeExecution() {
          throw new Error('busy-thread connector must not start a direct route');
        },
      },
      socketManager,
      invocationRecordStore: {},
      invocationTracker: {},
      invocationQueue: queue,
      queueProcessor: { isThreadBusy: () => true, tryAutoExecute: async () => false },
      messageStore: messages,
      queueCustodyCoordinator: coordinator,
      log: noOpLog(),
    });
    const policy = { forceQueue: true, coalesceKey: `cancel-during-restore-${coalesced}` };
    assert.equal(
      await trigger.trigger(
        source.threadId,
        'codex-astra',
        source.userId,
        source.content,
        source.id,
        undefined,
        policy,
      ),
      'enqueued',
    );
    const sibling = coalesced
      ? messages.append({
          threadId: source.threadId,
          userId: source.userId,
          catId: null,
          content: 'Independent work remains',
          mentions: ['codex-astra'],
          timestamp: 1_483,
        })
      : undefined;
    if (sibling) {
      assert.equal(
        await trigger.trigger(
          sibling.threadId,
          'codex-astra',
          sibling.userId,
          sibling.content,
          sibling.id,
          undefined,
          policy,
        ),
        'enqueued',
      );
    }
    const [entry] = queue.list(source.threadId, source.userId);
    assert.ok(entry);
    assert.deepEqual(entry.mergedMessageIds, sibling ? [sibling.id] : []);
    const readerInvocationId = `terminal-reader-canceled-during-restore-${coalesced}`;
    assert.equal(
      queue.markQueuedSeen(source.threadId, source.userId, entry.id, 'codex-astra', readerInvocationId, 1_484),
      true,
    );
    await coordinator.persistEntry(queue.getEntrySnapshot(source.threadId, source.userId, entry.id));

    let checkingDurable = false;
    let failedLookup = false;
    let restoring = false;
    let enteredLookup;
    const lookupEntered = new Promise((resolve) => {
      enteredLookup = resolve;
    });
    let releaseLookup;
    const lookupReleased = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    const getById = messages.getById.bind(messages);
    messages.getById = async (messageId) => {
      if (checkingDurable && !failedLookup && messageId === source.id) {
        failedLookup = true;
        throw new Error('one transient durable-source lookup failure');
      }
      const snapshot = structuredClone(getById(messageId));
      const delayedMessageId = sibling?.id ?? source.id;
      if (restoring && messageId === delayedMessageId) {
        enteredLookup();
        await lookupReleased;
      }
      return snapshot;
    };
    const admission = new QueueSourceCustodyAdmissionService({ queue, messageStore: messages });
    const processor = new QueueProcessor({
      queue,
      messageStore: messages,
      queueCustodyCoordinator: coordinator,
      queueSourceCustodyAdmission: {
        restoreHandledCarrier(result) {
          restoring = true;
          return admission.restoreHandledCarrier(result);
        },
      },
      invocationTracker: {},
      invocationRecordStore: {},
      router: {},
      socketManager,
      log: noOpLog(),
    });
    const hasDurableMessageCustody = processor.hasDurableMessageCustody.bind(processor);
    processor.hasDurableMessageCustody = async (...args) => {
      checkingDurable = true;
      try {
        return await hasDurableMessageCustody(...args);
      } finally {
        checkingDurable = false;
      }
    };
    const terminal = processor.markQueuedHandledOnSuccess(source.threadId, 'codex-astra', readerInvocationId);
    await lookupEntered;
    assert.deepEqual(queue.list(source.threadId, source.userId), []);
    assert.equal((await messages.markCanceled(source.id))?.deliveryTransitioned, true);
    releaseLookup();
    await terminal;

    const remaining = queue.list(source.threadId, source.userId);
    if (!sibling) {
      assert.deepEqual(remaining, []);
      assert.deepEqual(queue.listAutoExecute(source.threadId), []);
      return;
    }
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.messageId, sibling.id);
    assert.deepEqual(remaining[0]?.mergedMessageIds, []);
    assert.equal(remaining[0]?.content, sibling.content);
    assert.deepEqual(
      queue.listAutoExecute(source.threadId).map((candidate) => candidate.messageId),
      [sibling.id],
    );
  });
}

test('busy GitHub subject-terminal wake gains durable Queue custody before full-context exposure', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-github-wait-owner',
    userId: null,
    catId: null,
    content: 'PR wait satisfied',
    mentions: ['codex61-sol'],
    timestamp: 1_500,
    source: {
      connector: 'github-wait',
      label: 'GitHub Wait',
      icon: 'github',
      url: 'https://github.com/zts212653/clowder-ai/pull/5314',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'wait-source-238',
          outcomeId: 'wait:pr:zts212653/cat-cafe#5314:g1:subject_terminal',
          ownerFence: { kind: 'containing_task', generation: 1 },
        },
      },
    },
  });
  const trigger = createBusyThreadTrigger(messages, queue);

  assert.equal(
    await trigger.trigger(source.threadId, 'codex61-sol', 'default-user', source.content, source.id, undefined, {
      reason: 'subject_terminal',
      sourceCategory: 'review',
    }),
    'enqueued',
  );

  const [entry] = queue.list(source.threadId, 'default-user');
  assert.ok(entry);
  const readerInvocationId = 'invocation-reading-github-wait';
  assert.equal(
    queue.markQueuedSeen(source.threadId, 'default-user', entry.id, 'codex61-sol', readerInvocationId, Date.now()),
    true,
  );
  const exposed = queue.getEntrySnapshot(source.threadId, 'default-user', entry.id);
  assert.ok(exposed);
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  assert.deepEqual(await coordinator.persistEntry(exposed), [source.id]);
  await coordinator.assertPromptExposurePersisted([source.id], 'codex61-sol', readerInvocationId);
  assert.equal(messages.getById(source.id)?.queueCustody?.entryId, entry.id);
});

test('custody admission refusal removes a newly staged connector carrier', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const source = messages.append({
    threadId: 'thread-deployment-owner',
    userId: 'user-1',
    catId: null,
    content: 'Deployment ready',
    mentions: ['codex-astra'],
    timestamp: 2_000,
    source: {
      connector: 'deployment-wait',
      label: 'Deployment Wait',
      icon: 'refresh-cw',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'task-refused-deployment',
          outcomeId: 'wait:deployment:runtime:g1:matched',
          ownerFence: { kind: 'containing_task', generation: 1 },
        },
      },
    },
  });
  messages.admitQueueCustody = () => ({ kind: 'conflict' });

  const trigger = createBusyThreadTrigger(messages, queue);
  await assert.rejects(
    trigger.trigger(source.threadId, 'codex-astra', source.userId, source.content, source.id),
    /Queue source custody admission failed .*: conflict/,
  );

  assert.deepEqual(queue.list(source.threadId, source.userId), []);
  assert.equal(messages.getById(source.id)?.deliveryStatus, undefined);
  assert.equal(messages.getById(source.id)?.queueCustody, undefined);
});

test('custody admission refusal restores a coalesced carrier without the rejected source', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const first = messages.append({
    threadId: 'thread-deployment-owner',
    userId: 'user-1',
    catId: null,
    content: 'First deployment ready',
    mentions: ['codex-astra'],
    timestamp: 3_000,
    source: {
      connector: 'deployment-wait',
      label: 'Deployment Wait',
      icon: 'refresh-cw',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'task-coalesced-deployment',
          outcomeId: 'wait:deployment:runtime:g1:matched',
          ownerFence: { kind: 'containing_task', generation: 1 },
        },
      },
    },
  });
  const rejected = messages.append({
    threadId: first.threadId,
    userId: first.userId,
    catId: null,
    content: 'Second deployment ready',
    mentions: ['codex-astra'],
    timestamp: 3_001,
    source: {
      connector: 'deployment-wait',
      label: 'Deployment Wait',
      icon: 'refresh-cw',
      meta: {
        waitContinuationCarrier: {
          v: 1,
          waitId: 'task-coalesced-deployment',
          outcomeId: 'wait:deployment:runtime:g1:matched',
          ownerFence: { kind: 'containing_task', generation: 1 },
        },
      },
    },
  });
  const trigger = createBusyThreadTrigger(messages, queue);
  const policy = { reason: 'deployment_wait_satisfied', coalesceKey: 'deployment:runtime:wait:codex-astra' };
  assert.equal(
    await trigger.trigger(first.threadId, 'codex-astra', first.userId, first.content, first.id, undefined, policy),
    'enqueued',
  );
  const [firstEntry] = queue.list(first.threadId, first.userId);
  assert.ok(firstEntry);
  const before = queue.getEntrySnapshot(first.threadId, first.userId, firstEntry.id);
  assert.ok(before);

  const admitQueueCustody = messages.admitQueueCustody.bind(messages);
  messages.admitQueueCustody = (messageId, custody) =>
    messageId === rejected.id ? { kind: 'conflict' } : admitQueueCustody(messageId, custody);
  await assert.rejects(
    trigger.trigger(rejected.threadId, 'codex-astra', rejected.userId, rejected.content, rejected.id, undefined, {
      ...policy,
      priority: 'urgent',
      suggestedSkill: 'receive-review',
    }),
    /Queue source custody admission failed .*: conflict/,
  );

  const [after] = queue.list(first.threadId, first.userId);
  assert.equal(queue.list(first.threadId, first.userId).length, 1);
  assert.deepEqual(after, before);
  assert.equal(messages.getById(rejected.id)?.deliveryStatus, undefined);
  assert.equal(messages.getById(rejected.id)?.queueCustody, undefined);
});
