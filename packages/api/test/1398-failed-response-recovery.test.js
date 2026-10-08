import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { failedResponseFixture } from './helpers/1398-failed-response-fixture.mjs';

const fixture = (options) =>
  failedResponseFixture(
    { messages: new MessageStore(), turns: new InMemoryTurnExecutionStore(), ledger: new InMemoryQueueLedgerStore() },
    options,
  );
const wakeRows = async (f) =>
  (await f.queue.listAllDurable('thread')).filter((row) => row.sourceCategory === 'a2a_failure');

test('startup failed response settles through the original response/caller-wake transaction exactly once', async () => {
  const f = await fixture();
  await f.recovery().reconcile({ processStartedAt: 200 });
  assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'failed');
  const [wake] = await wakeRows(f);
  assert.deepEqual(wake.targets, ['codex']);
  assert.equal(wake.payload.messageId, f.response.id);
  assert.equal(wake.execution.ownerAuthProvenance, 'strict');
  assert.equal(wake.execution.a2aParentInvocationId, 'parent');
  assert.deepEqual(f.turns.listResponsePending(), []);
  await f.recovery().reconcile({ processStartedAt: 200 });
  assert.equal((await wakeRows(f)).length, 1);
  assert.equal(f.messages.getByThread('thread').length, 2);
});

test('failed atomic wake admission keeps response processing and recovery obligation until retry', async () => {
  const f = await fixture();
  const enqueue = f.ledger.enqueueNow.bind(f.ledger);
  f.ledger.enqueueNow = () => {
    throw new Error('ledger outage');
  };
  await f.recovery().reconcile({ processStartedAt: 200 });
  assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'processing');
  assert.equal(f.turns.listResponsePending().length, 1);
  assert.equal((await wakeRows(f)).length, 0);
  f.ledger.enqueueNow = enqueue;
  await f.recovery().reconcile({ processStartedAt: 200 });
  assert.equal((await wakeRows(f)).length, 1);
  assert.equal(f.turns.listResponsePending().length, 0);
});

test('commit acknowledgement lost after atomic response/wake survives restart without duplicate return', async () => {
  const f = await fixture();
  await f
    .recovery({
      afterCommit: () => {
        throw new Error('lost commit acknowledgement');
      },
    })
    .reconcile({ processStartedAt: 200 });
  assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'failed');
  assert.equal(f.turns.listResponsePending().length, 1);
  const restored = new InvocationQueue(f.ledger);
  await restored.hydrateFromLedger(f.messages);
  await f.recovery({ queueOwner: restored }).reconcile({ processStartedAt: 200 });
  assert.equal((await restored.listAllDurable('thread')).length, 1);
  assert.equal(f.turns.listResponsePending().length, 0);
});

for (const options of [
  { status: 'canceled' },
  { status: 'interrupted' },
  { status: 'succeeded' },
  { rejected: true },
  { isFailureReport: true },
]) {
  test('recovery does not manufacture failed-return bounce: ' + JSON.stringify(options), async () => {
    const f = await fixture(options);
    await f.recovery().reconcile({ processStartedAt: 200 });
    assert.equal((await wakeRows(f)).length, 0);
    assert.equal(f.turns.listResponsePending().length, 0);
    assert.equal(f.messages.getByThread('thread').length, 2);
  });
}

for (const mutate of [
  (response) => {
    response.extra.a2aFailureReturn.callerCatId = 'kimi';
  },
  (response) => {
    response.extra.a2aFailureReturn.triggerMessageId = 'wrong-source';
  },
  (response) => {
    delete response.extra.a2aFailureReturn;
  },
]) {
  test('recovery with missing or conflicting admission provenance keeps obligation and emits no wake', async () => {
    const f = await fixture();
    // Test-owned store injection, not mutation of runtime data.
    mutate(f.messages.getById(f.response.id));
    await f.recovery().reconcile({ processStartedAt: 200 });
    assert.equal((await wakeRows(f)).length, 0);
    assert.equal(f.turns.listResponsePending().length, 1);
    assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'processing');
  });
}

for (const [name, mutate] of [
  [
    'owner',
    (input) => {
      input.userId = 'other-owner';
    },
  ],
  [
    'thread',
    (input) => {
      input.threadId = 'other-thread';
    },
  ],
  [
    'dispatch response',
    (input) => {
      input.lifecycle.dispatchRefs[0].statusMessageId = 'other-response';
    },
  ],
  [
    'ambiguous target',
    (input) => {
      input.lifecycle.dispatchRefs.push({ ...input.lifecycle.dispatchRefs[0] });
    },
  ],
]) {
  test(`failed recovery rejects ${name} mismatch without clearing its obligation`, async () => {
    const f = await fixture();
    mutate(f.messages.getById(f.input.id));
    await f.recovery().reconcile({ processStartedAt: 200 });
    assert.equal((await wakeRows(f)).length, 0);
    assert.equal(f.turns.listResponsePending().length, 1);
    assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'processing');
  });
}

test('failed recovery settles only its exact target and leaves the admitted sibling response intact', async () => {
  const f = await fixture();
  const sibling = await f.messages.append({
    from: { kind: 'agent', catId: 'kimi' },
    userId: 'owner',
    threadId: 'thread',
    content: 'sibling draft',
    mentions: [],
    timestamp: 111,
    replyTo: f.input.id,
    lifecycle: {
      kind: 'response',
      orderKey: '111',
      invocationId: 'sibling',
      targetId: 'kimi',
      inputEntryIds: ['sibling-entry'],
      inputMessageIds: [f.input.id],
      status: 'processing',
      startedAt: 111,
    },
  });
  await f.messages.advanceLifecycleInputDispatch(f.input.id, {
    kind: 'input',
    orderKey: '100',
    targetId: 'kimi',
    phase: 'dispatched',
    statusMessageId: sibling.id,
    dispatchedAt: 111,
  });
  const before = structuredClone(f.messages.getById(sibling.id));
  await f.recovery().reconcile({ processStartedAt: 200 });
  assert.deepEqual(f.messages.getById(sibling.id), before);
  const refs = f.messages.getById(f.input.id).lifecycle.dispatchRefs;
  assert.equal(refs.find((ref) => ref.targetId === 'opus').phase, 'settled');
  assert.equal(refs.find((ref) => ref.targetId === 'kimi').phase, 'dispatched');
  assert.equal((await wakeRows(f)).length, 1);
});

for (const grade of ['unknown', 'compatibility_fallback']) {
  test(`failed recovery preserves admission authority ${grade} without promotion`, async () => {
    const f = await fixture();
    f.messages.getById(f.response.id).extra.a2aFailureReturn.ownerAuthProvenance = grade;
    await f.recovery().reconcile({ processStartedAt: 200 });
    const [wake] = await wakeRows(f);
    assert.equal(wake.execution.ownerAuthProvenance, grade);
    assert.deepEqual(wake.targets, ['codex']);
  });
}
