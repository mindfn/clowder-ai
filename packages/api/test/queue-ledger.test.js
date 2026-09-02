import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryQueueLedgerStore } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
);
const { queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js');
const { createQueueLedgerAdmission } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js'
);

function row(sourceId, targetCatId, overrides = {}) {
  return {
    version: 1,
    id: queueEntryId(sourceId, targetCatId),
    threadId: 'thread-1',
    owner: { kind: 'user', userId: 'owner-1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'owner-1' },
    target: { kind: 'cat', catId: targetCatId },
    payload: { sourceId, content: `body:${sourceId}`, messageId: sourceId },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {},
    status: 'queued',
    enqueuedAt: 100,
    priority: 'normal',
    ...overrides,
  };
}

describe('ADR-043 queue ledger', () => {
  it('derives one deterministic primary key from source identity and target', () => {
    assert.equal(queueEntryId('message-1', 'opus'), queueEntryId('message-1', 'opus'));
    assert.notEqual(queueEntryId('message-1', 'opus'), queueEntryId('message-1', 'codex'));
    assert.notEqual(queueEntryId('message-1', 'opus'), queueEntryId('message-2', 'opus'));
  });

  it('fans every resolved target into a scalar row and keeps targetless user work assignable', () => {
    const base = {
      sourceId: 'source-1',
      threadId: 'thread-1',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      content: 'hello',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      enqueuedAt: 100,
    };
    const fanout = createQueueLedgerAdmission({ ...base, targetCatIds: ['opus', 'codex'] });
    assert.deepEqual(
      fanout.map((entry) => entry.target),
      [
        { kind: 'cat', catId: 'opus' },
        { kind: 'cat', catId: 'codex' },
      ],
    );
    assert.deepEqual(createQueueLedgerAdmission({ ...base, targetCatIds: [] })[0].target, { kind: 'unassigned' });
  });

  it('atomically fan-outs a source into independent single-target rows', async () => {
    const store = new InMemoryQueueLedgerStore();
    const result = await store.enqueue([row('message-1', 'opus'), row('message-1', 'codex')], 5);
    assert.equal(result.outcome, 'enqueued');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => entry.target.catId),
      ['opus', 'codex'],
    );
  });

  it('rejects a partial replay instead of duplicating part of a fan-out group', async () => {
    const store = new InMemoryQueueLedgerStore();
    await store.enqueue([row('message-1', 'opus')]);
    const result = await store.enqueue([row('message-1', 'opus'), row('message-1', 'codex')]);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => entry.target.catId),
      ['opus'],
    );
  });

  it('claims without removing and restores the exact original queue position', async () => {
    const store = new InMemoryQueueLedgerStore();
    const first = row('message-1', 'opus');
    const second = row('message-2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);

    const claimed = await store.claim('thread-1', first.id, 'claim-1', 200);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => [entry.id, entry.status]),
      [
        [first.id, 'claimed'],
        [second.id, 'queued'],
      ],
    );

    assert.equal((await store.restore('thread-1', first.id, 'stale-claim')).outcome, 'state_changed');
    assert.equal((await store.restore('thread-1', first.id, 'claim-1')).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => entry.id),
      [first.id, second.id],
    );
  });

  it('atomically binds one targetless row while claiming it for Steer', async () => {
    const store = new InMemoryQueueLedgerStore();
    const targetless = row('message-1', 'placeholder', {
      id: queueEntryId('message-1'),
      target: { kind: 'unassigned' },
    });
    await store.enqueue([targetless]);
    const claimed = await store.claim('thread-1', targetless.id, 'claim-targetless', 200, 'codex', 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].target, { kind: 'cat', catId: 'codex' });
    assert.equal(claimed.entries[0].delivery.steerRequestedAt, 199);
    const restored = await store.restore('thread-1', targetless.id, 'claim-targetless');
    assert.equal(restored.outcome, 'updated');
    assert.equal(restored.entry.delivery.steerRequestedAt, undefined);
  });

  it('counts a fan-out group as one user queue message', async () => {
    const store = new InMemoryQueueLedgerStore();
    assert.equal((await store.enqueue([row('message-1', 'opus'), row('message-1', 'codex')], 1)).outcome, 'enqueued');
    assert.equal((await store.enqueue([row('message-2', 'opus')], 1)).outcome, 'full');
  });

  it('removes terminal work from active order while retaining an idempotency tombstone', async () => {
    const store = new InMemoryQueueLedgerStore();
    const entry = row('message-1', 'opus');
    await store.enqueue([entry]);
    await store.claim('thread-1', entry.id, 'claim-1', 200);
    assert.equal((await store.commit('thread-1', entry.id, 'wrong', 'processing', 201)).outcome, 'state_changed');
    const processing = await store.commit('thread-1', entry.id, 'claim-1', 'processing', 201);
    assert.equal(processing.outcome, 'updated');
    assert.equal(processing.entry.status, 'processing');
    assert.equal((await store.restore('thread-1', entry.id, 'claim-1')).outcome, 'state_changed');
    assert.equal((await store.commit('thread-1', entry.id, '', 'terminal', 300)).outcome, 'updated');
    assert.deepEqual(await store.list('thread-1'), []);
    assert.deepEqual(await store.get('thread-1', entry.id), {
      ...entry,
      status: 'terminal',
      processingStartedAt: 201,
      terminalAt: 300,
    });

    const replay = await store.enqueue([{ ...entry, enqueuedAt: 999 }]);
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.entries[0].status, 'terminal');
    assert.deepEqual(await store.list('thread-1'), []);
    assert.equal(
      (await store.enqueue([{ ...entry, payload: { ...entry.payload, content: 'changed' } }])).outcome,
      'conflict',
    );
  });

  it('claims a prefix all-or-nothing', async () => {
    const store = new InMemoryQueueLedgerStore();
    const first = row('message-1', 'opus');
    const second = row('message-2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    await store.claim('thread-1', second.id, 'other', 150);

    const result = await store.claimPrefix('thread-1', [first.id, second.id], 'batch', 200, undefined, 199);
    assert.equal(result.outcome, 'state_changed');
    assert.equal((await store.get('thread-1', first.id)).status, 'queued');
  });
});
