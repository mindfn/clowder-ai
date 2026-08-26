import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceDispatchRef,
  applyLifecycleTerminal,
  applyVisibleQueueOrder,
  compareLifecycleQueueEntries,
  compareQueueOrderShadow,
  rememberBoundedShadowScope,
  summarizeQueueOrderShadow,
  transitionLifecycleWriterEpoch,
  validateLifecycleQueueEntry,
} = await import('../dist/domains/cats/services/agents/invocation/message-lifecycle-kernel.js');

const inline = (text) => ({ type: 'inline', body: [{ type: 'text', text }] });

function conversationEntry(overrides = {}) {
  return {
    id: 'entry-a',
    threadId: 'thread-1',
    kind: 'conversation_input',
    sourceRecordId: 'message-a',
    payload: inline('hello'),
    from: { kind: 'user', userId: 'user-1' },
    targets: [],
    ownerAuthProvenance: 'strict',
    priority: 'normal',
    enqueuedAt: 100,
    ...overrides,
  };
}

describe('message lifecycle QueueEntry contract', () => {
  it('accepts only the three legal kind/payload/target combinations', () => {
    assert.deepEqual(validateLifecycleQueueEntry(conversationEntry()), { valid: true });
    assert.deepEqual(
      validateLifecycleQueueEntry(
        conversationEntry({
          id: 'wake',
          kind: 'message_wake',
          sourceRecordId: undefined,
          payload: { type: 'message_ref', messageId: 'history-1' },
          from: { kind: 'agent', catId: 'opus' },
          targets: ['codex'],
        }),
      ),
      { valid: true },
    );
    assert.deepEqual(
      validateLifecycleQueueEntry(
        conversationEntry({
          id: 'private',
          kind: 'private_input',
          sourceRecordId: undefined,
          targets: ['codex'],
        }),
      ),
      { valid: true },
    );

    assert.equal(
      validateLifecycleQueueEntry(conversationEntry({ kind: 'message_wake', sourceRecordId: undefined })).valid,
      false,
      'message_wake cannot carry inline content',
    );
    assert.equal(
      validateLifecycleQueueEntry(conversationEntry({ kind: 'private_input', sourceRecordId: undefined, targets: [] }))
        .valid,
      false,
      'private_input must have an exact target',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({
          kind: 'private_input',
          sourceRecordId: undefined,
          targets: ['codex'],
          position: 0,
        }),
      ).valid,
      false,
      'hidden private_input cannot carry a client-visible position',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({
          kind: 'conversation_input',
          payload: { type: 'message_ref', messageId: 'history-1' },
        }),
      ).valid,
      false,
      'conversation_input cannot refer to an existing History message',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({ from: { kind: 'external', connectorId: 'github', sender: { name: 'missing-id' } } }),
      ).valid,
      false,
      'external actors remain in a validated connector/sender namespace',
    );
  });

  it('sorts only by position, priority, FIFO time, and id', () => {
    const entries = [
      conversationEntry({ id: 'normal-old', enqueuedAt: 10 }),
      conversationEntry({ id: 'urgent-new', priority: 'urgent', enqueuedAt: 30 }),
      conversationEntry({ id: 'urgent-old-z', priority: 'urgent', enqueuedAt: 20 }),
      conversationEntry({ id: 'urgent-old-a', priority: 'urgent', enqueuedAt: 20 }),
      conversationEntry({ id: 'positioned', position: 4, enqueuedAt: 40 }),
    ];

    assert.deepEqual(
      entries.sort(compareLifecycleQueueEntries).map((entry) => entry.id),
      ['positioned', 'urgent-old-a', 'urgent-old-z', 'urgent-new', 'normal-old'],
    );
  });
});

describe('visible Queue reorder reducer', () => {
  const privateEntry = conversationEntry({
    id: 'private',
    kind: 'private_input',
    sourceRecordId: undefined,
    targets: ['codex'],
    enqueuedAt: 25,
  });
  const entries = [
    conversationEntry({ id: 'v1', enqueuedAt: 10 }),
    privateEntry,
    conversationEntry({ id: 'v2', enqueuedAt: 20 }),
    conversationEntry({ id: 'v3', enqueuedAt: 30 }),
  ];

  it('atomically replaces the complete visible order without addressing hidden entries', () => {
    const result = applyVisibleQueueOrder(
      { revision: 'r1', entries, reorderableVisibleEntryIds: ['v1', 'v2', 'v3'] },
      { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['v1', 'v3', 'v2'] },
      'r2',
    );

    assert.equal(result.outcome, 'applied');
    assert.equal(result.snapshot.revision, 'r2');
    assert.deepEqual(
      result.snapshot.entries.sort(compareLifecycleQueueEntries).map((entry) => entry.id),
      ['v1', 'v3', 'v2', 'private'],
    );
    assert.equal(result.snapshot.entries.find((entry) => entry.id === 'private').position, undefined);
  });

  it('fails closed on stale revision, duplicate ids, hidden ids, or an incomplete visible set', () => {
    const snapshot = { revision: 'r1', entries, reorderableVisibleEntryIds: ['v1', 'v2', 'v3'] };
    for (const [expectedQueueRevision, orderedVisibleEntryIds, reason] of [
      ['stale', ['v1', 'v2', 'v3'], 'stale_revision'],
      ['r1', ['v1', 'v1', 'v3'], 'invalid_order'],
      ['r1', ['v1', 'private', 'v2', 'v3'], 'visible_set_changed'],
      ['r1', ['v1', 'v2'], 'visible_set_changed'],
    ]) {
      const result = applyVisibleQueueOrder(
        snapshot,
        { threadId: 'thread-1', expectedQueueRevision, orderedVisibleEntryIds },
        'r2',
      );
      assert.deepEqual(result, { outcome: 'conflict', reason });
    }
    assert.ok(
      entries.every((entry) => entry.position === undefined),
      'conflicts must not partially mutate input',
    );
    assert.deepEqual(
      applyVisibleQueueOrder(
        snapshot,
        {
          threadId: 'thread-1',
          expectedQueueRevision: 'r1',
          orderedVisibleEntryIds: ['v1', 'v2', 'v3'],
        },
        'r1',
      ),
      { outcome: 'conflict', reason: 'invalid_revision' },
    );
  });

  it('rejects invalid or duplicate canonical snapshot identities before assigning positions', () => {
    const duplicated = [
      conversationEntry({ id: 'duplicate', enqueuedAt: 10 }),
      conversationEntry({ id: 'duplicate', enqueuedAt: 20 }),
    ];
    assert.deepEqual(
      applyVisibleQueueOrder(
        { revision: 'r1', entries: duplicated, reorderableVisibleEntryIds: ['duplicate'] },
        { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['duplicate'] },
        'r2',
      ),
      { outcome: 'conflict', reason: 'invalid_snapshot' },
    );

    assert.deepEqual(
      applyVisibleQueueOrder(
        {
          revision: 'r1',
          entries: [
            conversationEntry({ id: 'visible', enqueuedAt: 20 }),
            conversationEntry({
              id: 'hidden',
              kind: 'private_input',
              sourceRecordId: undefined,
              targets: ['codex'],
              position: 0,
              enqueuedAt: 10,
            }),
          ],
          reorderableVisibleEntryIds: ['visible'],
        },
        { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['visible'] },
        'r2',
      ),
      { outcome: 'conflict', reason: 'invalid_snapshot' },
    );
  });
});

describe('derived ref, terminal, and writer-epoch reducers', () => {
  it('allows only monotonic dispatch-ref transitions and idempotent replay', () => {
    const assigned = { targetId: 'codex', phase: 'assigned' };
    const dispatched = { targetId: 'codex', phase: 'dispatched', statusMessageId: 'response-1' };
    const settled = { targetId: 'codex', phase: 'settled', statusMessageId: 'response-1' };

    assert.deepEqual(advanceDispatchRef(assigned, dispatched), { outcome: 'applied', ref: dispatched });
    assert.deepEqual(advanceDispatchRef(assigned, settled), { outcome: 'applied', ref: settled });
    assert.deepEqual(advanceDispatchRef(dispatched, settled), { outcome: 'applied', ref: settled });
    assert.deepEqual(advanceDispatchRef(settled, settled), { outcome: 'replayed', ref: settled });
    assert.equal(advanceDispatchRef(settled, dispatched).outcome, 'conflict');
    assert.equal(
      advanceDispatchRef(assigned, { targetId: 'opus', phase: 'settled', statusMessageId: 'failure-1' }).outcome,
      'conflict',
    );
    assert.equal(
      advanceDispatchRef(dispatched, {
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: 'response-2',
      }).outcome,
      'conflict',
      'one target cannot be relinked to a different response bubble',
    );
  });

  it('commits one terminal per invocation and replays only the same fact', () => {
    const bubble = {
      id: 'response-1',
      threadId: 'thread-1',
      orderKey: '2',
      invocationId: 'invocation-1',
      targetId: 'codex',
      inputEntryIds: ['entry-a'],
      inputMessageIds: ['message-a'],
      body: [],
      status: 'processing',
      startedAt: 100,
    };
    const terminal = { status: 'failed', body: [{ type: 'text', text: 'partial' }], completedAt: 200, reason: 'boom' };
    const first = applyLifecycleTerminal(bubble, terminal);
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(applyLifecycleTerminal(first.bubble, terminal), { outcome: 'replayed', bubble: first.bubble });
    assert.equal(applyLifecycleTerminal(first.bubble, { ...terminal, status: 'completed' }).outcome, 'conflict');
    assert.equal(
      applyLifecycleTerminal(bubble, { ...terminal, status: 'processing' }).outcome,
      'conflict',
      'runtime validation must reject a non-terminal status even for untyped callers',
    );
  });

  it('requires a migration lease and clean scan for monotonic writer activation', () => {
    const migrating = transitionLifecycleWriterEpoch(
      { epoch: 'legacy' },
      { expectedEpoch: 'legacy', nextEpoch: 'migrating', migrationLeaseId: 'lease-1' },
    );
    assert.deepEqual(migrating, {
      outcome: 'applied',
      state: { epoch: 'migrating', migrationLeaseId: 'lease-1' },
    });
    assert.equal(
      transitionLifecycleWriterEpoch(migrating.state, {
        expectedEpoch: 'migrating',
        nextEpoch: 'live',
        migrationLeaseId: 'lease-1',
        cleanScan: false,
      }).outcome,
      'blocked',
    );
    const activated = transitionLifecycleWriterEpoch(migrating.state, {
      expectedEpoch: 'migrating',
      nextEpoch: 'live',
      migrationLeaseId: 'lease-1',
      cleanScan: true,
    });
    assert.deepEqual(activated, {
      outcome: 'applied',
      state: { epoch: 'live', migrationLeaseId: 'lease-1' },
    });
    assert.deepEqual(
      transitionLifecycleWriterEpoch(activated.state, {
        expectedEpoch: 'migrating',
        nextEpoch: 'live',
        migrationLeaseId: 'lease-1',
        cleanScan: true,
      }),
      { outcome: 'replayed', state: activated.state },
    );

    assert.deepEqual(
      transitionLifecycleWriterEpoch(activated.state, {
        expectedEpoch: 'legacy',
        nextEpoch: 'live',
        migrationLeaseId: '',
      }),
      { outcome: 'conflict', reason: 'lease_mismatch' },
    );
    assert.deepEqual(
      transitionLifecycleWriterEpoch(activated.state, {
        expectedEpoch: 'migrating',
        nextEpoch: 'live',
        migrationLeaseId: 'wrong',
        cleanScan: true,
      }),
      { outcome: 'conflict', reason: 'lease_mismatch' },
    );
    assert.deepEqual(
      transitionLifecycleWriterEpoch(activated.state, {
        expectedEpoch: 'migrating',
        nextEpoch: 'live',
        migrationLeaseId: 'lease-1',
      }),
      { outcome: 'blocked', reason: 'migration_not_clean' },
    );
    assert.deepEqual(
      transitionLifecycleWriterEpoch(activated.state, {
        expectedEpoch: 'live',
        nextEpoch: 'live',
        migrationLeaseId: 'lease-1',
        cleanScan: true,
      }),
      { outcome: 'conflict', reason: 'invalid_transition' },
    );
    assert.deepEqual(
      transitionLifecycleWriterEpoch(migrating.state, {
        expectedEpoch: 'live',
        nextEpoch: 'migrating',
        migrationLeaseId: 'lease-1',
      }),
      { outcome: 'conflict', reason: 'invalid_transition' },
    );
  });
});

describe('legacy/new order shadow comparison', () => {
  it('reports the first order delta without changing either side', () => {
    const newEntries = [
      conversationEntry({ id: 'normal', enqueuedAt: 10 }),
      conversationEntry({ id: 'urgent', priority: 'urgent', enqueuedAt: 20 }),
    ];
    assert.deepEqual(compareQueueOrderShadow(['normal', 'urgent'], newEntries), {
      matches: false,
      legacyEntryIds: ['normal', 'urgent'],
      lifecycleEntryIds: ['urgent', 'normal'],
      firstMismatchIndex: 0,
    });
  });

  it('bounds remembered scopes and emits only bounded samples plus digests', () => {
    const scopes = new Set();
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-a', 2), true);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-a', 2), false);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-b', 2), true);
    assert.equal(rememberBoundedShadowScope(scopes, 'scope-c', 2), true);
    assert.deepEqual([...scopes], ['scope-b', 'scope-c']);

    const comparison = compareQueueOrderShadow(
      ['a', 'b', 'c', 'd'],
      [
        { id: 'd', priority: 'urgent', enqueuedAt: 4 },
        { id: 'c', priority: 'urgent', enqueuedAt: 3 },
        { id: 'b', priority: 'normal', enqueuedAt: 2 },
        { id: 'a', priority: 'normal', enqueuedAt: 1 },
      ],
    );
    const summary = summarizeQueueOrderShadow(comparison, 2);
    assert.equal(summary.legacyCount, 4);
    assert.equal(summary.lifecycleCount, 4);
    assert.equal(summary.legacyEntryIdSample.length, 2);
    assert.equal(summary.lifecycleEntryIdSample.length, 2);
    assert.match(summary.legacyOrderDigest, /^[a-f0-9]{16}$/);
    assert.match(summary.lifecycleOrderDigest, /^[a-f0-9]{16}$/);
  });
});
