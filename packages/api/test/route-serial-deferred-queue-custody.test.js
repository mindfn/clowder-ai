import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueSourceCustodyAdmissionService } from '../dist/domains/cats/services/agents/invocation/QueueSourceCustodyAdmission.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function createFixture(invoke) {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  let invocationSeq = 0;
  return {
    messages,
    queue,
    coordinator,
    deps: {
      services: { opus: { invoke } },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/test',
        },
        apiUrl: 'http://127.0.0.1:3004',
      },
      messageStore: messages,
      queueSourceCustodyAdmission: new QueueSourceCustodyAdmissionService({
        queue,
        messageStore: messages,
        queueCustodyCoordinator: coordinator,
      }),
    },
  };
}

async function assertDeferredSourceExposure(fixture, threadId) {
  const [entry] = fixture.queue.list(threadId, 'user-a');
  assert.ok(entry, 'the deferred A2A carrier must remain queued');
  assert.equal(typeof entry.messageId, 'string', 'the persisted agent reply must remain the exact Queue source');
  const invocationId = `reader-${threadId}`;
  assert.equal(fixture.queue.markQueuedSeen(threadId, 'user-a', entry.id, 'codex', invocationId, Date.now()), true);
  const exposed = fixture.queue.getEntrySnapshot(threadId, 'user-a', entry.id);
  assert.ok(exposed);
  assert.deepEqual(
    await fixture.coordinator.persistEntry(exposed),
    [entry.messageId],
    'the Queue exposure must persist against the exact ordinary source',
  );
  await fixture.coordinator.assertPromptExposurePersisted([entry.messageId], 'codex', invocationId);
}

test('queued-user fairness defer admits the persisted A2A reply before full-context exposure', async () => {
  const fixture = createFixture(async function* () {
    yield { type: 'text', catId: 'opus', content: '完成\n@codex 请继续', timestamp: Date.now() };
    yield { type: 'done', catId: 'opus', timestamp: Date.now() };
  });
  const threadId = 'thread-fairness-source-custody';

  for await (const _ of routeSerial(fixture.deps, ['opus'], 'start', 'user-a', threadId, {
    queueHasQueuedMessages: () => true,
    deferA2AEnqueue: (entry) => fixture.queue.enqueue(entry),
  })) {
    // drain
  }

  await assertDeferredSourceExposure(fixture, threadId);
});

test('seal-abort recovery admits the persisted A2A reply before full-context exposure', async () => {
  const controller = new AbortController();
  const fixture = createFixture(async function* () {
    yield { type: 'text', catId: 'opus', content: '完成\n@codex 请继续', timestamp: Date.now() };
    controller.abort();
    yield { type: 'done', catId: 'opus', timestamp: Date.now() };
  });
  const threadId = 'thread-abort-source-custody';

  for await (const _ of routeSerial(fixture.deps, ['opus'], 'start', 'user-a', threadId, {
    signal: controller.signal,
    queueHasQueuedMessages: () => true,
    deferA2AEnqueue: (entry) => fixture.queue.enqueue(entry),
  })) {
    // drain
  }

  await assertDeferredSourceExposure(fixture, threadId);
});

test('one ordinary multi-mention source retains independent durable carriers for two occupied targets', async () => {
  const threadId = 'thread-two-occupied-targets';
  const userId = 'user-a';
  const tracker = new InvocationTracker();
  const occupied = tracker.startAll(threadId, ['codex', 'sonnet'], userId, 'occupied-batch');
  const parent = tracker.startAll(threadId, ['opus'], userId, 'parent-batch');
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  let invocationSeq = 0;
  const deps = {
    services: {
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n@sonnet\n请分别接手', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          throw new Error('occupied codex invoked inline');
        },
      },
      sonnet: {
        async *invoke() {
          throw new Error('occupied sonnet invoked inline');
        },
      },
    },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: messages,
    queueSourceCustodyAdmission: new QueueSourceCustodyAdmissionService({
      queue,
      messageStore: messages,
      queueCustodyCoordinator: coordinator,
    }),
  };
  const errors = [];

  try {
    for await (const message of routeSerial(deps, ['opus'], 'start', userId, threadId, {
      signal: parent.signal,
      invocationController: parent,
      deferA2AEnqueue: (entry) => queue.enqueue(entry),
      trackA2ASlot: (candidateThreadId, catId, candidateUserId, controller) =>
        tracker.trackExternalSlot(candidateThreadId, catId, controller, candidateUserId, [catId], 'parent-batch'),
      completeA2ASlots: (candidateThreadId, catIds, controller) => {
        for (const catId of catIds) tracker.completeSlot(candidateThreadId, catId, controller);
      },
    })) {
      if (message.type === 'error') errors.push(message.content ?? message.error);
      if (message.type === 'done' && message.catId === 'opus') tracker.completeSlot(threadId, 'opus', parent);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const entries = queue.list(threadId, userId);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.flatMap((entry) => entry.targetCats).sort(), ['codex', 'sonnet']);
  const sourceMessageId = entries[0]?.messageId;
  assert.ok(sourceMessageId);
  assert.ok(entries.every((entry) => entry.messageId === sourceMessageId));
  const custody = messages.getById(sourceMessageId)?.queueCustody;
  assert.deepEqual(custody?.pendingTargetCats.slice().sort(), ['codex', 'sonnet']);
  assert.equal(
    custody?.carrierByTargetCatId?.codex?.entryId,
    entries.find((entry) => entry.targetCats[0] === 'codex')?.id,
  );
  assert.equal(
    custody?.carrierByTargetCatId?.sonnet?.entryId,
    entries.find((entry) => entry.targetCats[0] === 'sonnet')?.id,
  );
  for (const [index, targetCatId] of ['codex', 'sonnet'].entries()) {
    const entry = entries.find((candidate) => candidate.targetCats[0] === targetCatId);
    assert.ok(entry);
    const invocationId = `reader-${targetCatId}`;
    const seenAt = entry.createdAt + 100 + index;
    assert.equal(queue.markQueuedSeen(threadId, userId, entry.id, targetCatId, invocationId, seenAt), true);
    const exposed = queue.getEntrySnapshot(threadId, userId, entry.id);
    assert.ok(exposed);
    assert.deepEqual(await coordinator.persistEntry(exposed), [sourceMessageId]);
    await coordinator.assertPromptExposurePersisted([sourceMessageId], targetCatId, invocationId);
    const handledAt = seenAt + 10;
    const settlement = await coordinator.commitSuccessfulTargets(exposed, [targetCatId], invocationId, handledAt, {
      [targetCatId]: {
        invocationId,
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId },
        handledAt,
      },
    });
    assert.deepEqual(settlement.perMessage[0].handledTargetCats, [targetCatId]);
  }
  const settledSource = messages.getById(sourceMessageId);
  assert.equal(settledSource?.deliveryStatus, 'delivered');
  assert.equal(settledSource?.queueCustody?.status, 'terminal');
  assert.deepEqual(settledSource?.queueCustody?.handledByCatIds.slice().sort(), ['codex', 'sonnet']);
  for (const catId of ['codex', 'sonnet']) tracker.completeSlot(threadId, catId, occupied);
});

test('ordinary multi-mention keeps the occupied target queued while the free sibling executes directly', async () => {
  const threadId = 'thread-mixed-target-admission';
  const userId = 'user-a';
  const tracker = new InvocationTracker();
  const occupied = tracker.startAll(threadId, ['codex'], userId, 'occupied-batch');
  const parent = tracker.startAll(threadId, ['opus'], userId, 'parent-batch');
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
  let invocationSeq = 0;
  let sonnetInvocations = 0;
  const deps = {
    services: {
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '@codex\n@sonnet\n请分别接手', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: {
        async *invoke() {
          throw new Error('occupied codex invoked inline');
        },
      },
      sonnet: {
        async *invoke() {
          sonnetInvocations += 1;
          yield { type: 'text', catId: 'sonnet', content: 'direct sibling handled', timestamp: Date.now() };
          yield { type: 'done', catId: 'sonnet', timestamp: Date.now() };
        },
      },
    },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: messages,
    queueSourceCustodyAdmission: new QueueSourceCustodyAdmissionService({
      queue,
      messageStore: messages,
      queueCustodyCoordinator: coordinator,
    }),
  };
  const errors = [];

  try {
    for await (const message of routeSerial(deps, ['opus'], 'start', userId, threadId, {
      signal: parent.signal,
      invocationController: parent,
      deferA2AEnqueue: (entry) => queue.enqueue(entry),
      trackA2ASlot: (candidateThreadId, catId, candidateUserId, controller) =>
        tracker.trackExternalSlot(candidateThreadId, catId, controller, candidateUserId, [catId], 'parent-batch'),
      completeA2ASlots: (candidateThreadId, catIds, controller) => {
        for (const catId of catIds) tracker.completeSlot(candidateThreadId, catId, controller);
      },
    })) {
      if (message.type === 'error') errors.push(message.content ?? message.error);
      if (message.type === 'done' && message.catId) tracker.completeSlot(threadId, message.catId, parent);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  assert.deepEqual(errors, []);
  assert.equal(sonnetInvocations, 1);
  const entries = queue.list(threadId, userId);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].targetCats, ['codex']);
  const sourceMessageId = entries[0].messageId;
  assert.ok(sourceMessageId);
  const custody = messages.getById(sourceMessageId)?.queueCustody;
  assert.deepEqual(custody?.pendingTargetCats, ['codex']);
  assert.equal(custody?.carrierByTargetCatId?.codex?.entryId, entries[0].id);
  tracker.completeSlot(threadId, 'codex', occupied);
});

test('route-deferred carriers stay unreadable during the source CAS and publish or disappear with its outcome', async () => {
  for (const admissionOutcome of ['commit', 'refuse']) {
    const threadId = `thread-route-admission-${admissionOutcome}`;
    const userId = 'user-a';
    const tracker = new InvocationTracker();
    const occupied = tracker.startAll(threadId, ['codex'], userId, `occupied-${admissionOutcome}`);
    const parent = tracker.startAll(threadId, ['opus'], userId, `parent-${admissionOutcome}`);
    const queue = new InvocationQueue();
    const messages = new MessageStore();
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
      return admissionOutcome === 'commit' ? admitQueueCustody(messageId, custody) : { kind: 'conflict' };
    };
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: messages });
    let invocationSeq = 0;
    const deps = {
      services: {
        opus: {
          async *invoke() {
            yield { type: 'text', catId: 'opus', content: '@codex\n请接手', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
        codex: {
          async *invoke() {
            throw new Error('occupied codex invoked inline');
          },
        },
      },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/test',
        },
        apiUrl: 'http://127.0.0.1:3004',
      },
      messageStore: messages,
      queueSourceCustodyAdmission: new QueueSourceCustodyAdmissionService({
        queue,
        messageStore: messages,
        queueCustodyCoordinator: coordinator,
      }),
    };
    const errors = [];
    const drain = (async () => {
      try {
        for await (const message of routeSerial(deps, ['opus'], 'start', userId, threadId, {
          signal: parent.signal,
          invocationController: parent,
          deferA2AEnqueue: (entry) => queue.enqueue(entry),
          trackA2ASlot: (candidateThreadId, catId, candidateUserId, controller) =>
            tracker.trackExternalSlot(
              candidateThreadId,
              catId,
              controller,
              candidateUserId,
              [catId],
              `parent-${admissionOutcome}`,
            ),
          completeA2ASlots: (candidateThreadId, catIds, controller) => {
            for (const catId of catIds) tracker.completeSlot(candidateThreadId, catId, controller);
          },
        })) {
          if (message.type === 'error') errors.push(message.content ?? message.error);
          if (message.type === 'done' && message.catId === 'opus') tracker.completeSlot(threadId, 'opus', parent);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    })();

    await entered;
    const [pending] = queue.list(threadId, userId);
    assert.ok(pending);
    assert.ok(pending.queueCustodyAdmissionId);
    assert.deepEqual(queue.listAutoExecute(threadId), []);
    assert.deepEqual(queue.getQueuedBodyMessagesForCat(threadId, userId, 'codex'), []);
    assert.equal(queue.markQueuedSeen(threadId, userId, pending.id, 'codex', 'pre-cas-reader'), false);
    releaseAdmission();
    await drain;

    if (admissionOutcome === 'commit') {
      assert.deepEqual(errors, []);
      const [published] = queue.list(threadId, userId);
      assert.equal(published.id, pending.id);
      assert.equal(published.queueCustodyAdmissionId, undefined);
      assert.deepEqual(
        queue.listAutoExecute(threadId).map((entry) => entry.id),
        [pending.id],
      );
    } else {
      assert.ok(errors.some((error) => String(error).includes('Queue source custody admission failed')));
      assert.deepEqual(queue.list(threadId, userId), []);
    }
    tracker.completeSlot(threadId, 'codex', occupied);
  }
});
