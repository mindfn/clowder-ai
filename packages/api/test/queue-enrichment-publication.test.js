/**
 * F220 intake — ordered, frozen, bounded queue_updated publication.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { emitQueueUpdated } = await import('../dist/utils/queue-enrichment.js');

describe('F220 intake: queue snapshot publication ordering', () => {
  const makeEntry = (overrides = {}) => ({
    version: 1,
    id: 'queue-entry',
    threadId: 't1',
    owner: { kind: 'user', userId: 'u1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'user-1' },
    target: { kind: 'cat', catId: 'opus' },
    payload: { sourceId: 'msg-entry', content: 'queued work', messageId: 'msg-entry' },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {},
    status: 'queued',
    enqueuedAt: 1,
    priority: 'normal',
    ...overrides,
  });

  it('never publishes private system input content', async () => {
    const emitted = [];
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    await emitQueueUpdated(
      socketManager,
      'u1',
      't1',
      [
        makeEntry({
          kind: 'private_input',
          from: { kind: 'system', service: 'podcast' },
          payload: { sourceId: 'private-prompt', content: 'secret podcast prompt' },
        }),
      ],
      null,
      'private',
    );
    assert.deepEqual(emitted[0].queue, []);
  });

  const makeWithdrawnLedgerEntry = (overrides = {}) => ({
    version: 1,
    id: 'withdrawn-entry',
    threadId: 't1',
    owner: { kind: 'user', userId: 'u1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'u1' },
    target: { kind: 'cat', catId: 'opus' },
    payload: { sourceId: 'msg-terminal', messageId: 'msg-terminal', content: 'withdrawn body' },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {
      terminalOutcome: 'withdrawn',
      failedAt: 20,
      failureReason: 'source_withdrawn',
    },
    status: 'terminal',
    enqueuedAt: 1,
    terminalAt: 20,
    priority: 'normal',
    ...overrides,
  });

  it('serializes same-scope snapshots while a different user remains independent', async () => {
    const emitted = [];
    let releaseOlder;
    let olderStarted;
    const olderStartedPromise = new Promise((resolve) => {
      olderStarted = resolve;
    });
    const messageStore = {
      getById: async (messageId) => {
        if (messageId === 'msg-older') {
          olderStarted();
          await new Promise((resolve) => {
            releaseOlder = resolve;
          });
        }
        return null;
      },
    };
    const receiptSource = {
      getDurableEntriesForMessages: async (_threadId, messageIds) =>
        new Map(messageIds.includes('msg-terminal') ? [['msg-terminal', [makeWithdrawnLedgerEntry()]]] : []),
    };
    const socketManager = {
      emitToUser: (userId, _event, data) =>
        emitted.push({
          userId,
          action: data.action,
          queue: data.queue,
          messageReceipts: data.messageReceipts,
        }),
    };

    const older = emitQueueUpdated(
      socketManager,
      'u1',
      't1',
      [
        makeEntry({
          id: 'older',
          payload: { sourceId: 'msg-older', content: 'older work', messageId: 'msg-older' },
        }),
      ],
      messageStore,
      'older',
    );
    await olderStartedPromise;
    const newer = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'newer', {
      receiptMessageIds: ['msg-terminal'],
      receiptSource,
    });
    const independent = emitQueueUpdated(socketManager, 'u2', 't1', [], messageStore, 'independent');

    try {
      await independent;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u1'),
        [],
        'newer same-scope snapshot must wait behind the older enrichment',
      );
      assert.deepEqual(
        emitted.filter((event) => event.userId === 'u2').map((event) => event.action),
        ['independent'],
        'different user scope must not share the tail',
      );
    } finally {
      releaseOlder?.();
      await Promise.allSettled([older, newer, independent]);
    }

    assert.deepEqual(
      emitted.filter((event) => event.userId === 'u1').map((event) => event.action),
      ['older', 'newer'],
    );
    assert.deepEqual(emitted.find((event) => event.action === 'newer')?.messageReceipts, [
      {
        messageId: 'msg-terminal',
        queueReceipt: {
          version: 1,
          entryId: 'msg-terminal',
          targets: [
            {
              catId: 'opus',
              state: 'withdrawn',
              withdrawnAt: 20,
              attempts: [
                {
                  id: 'withdrawn-entry:1',
                  targetCatId: 'opus',
                  sequence: 1,
                  state: 'cancelled',
                  createdAt: 1,
                  updatedAt: 20,
                  terminalReason: 'source_withdrawn',
                },
              ],
            },
          ],
          reminderAttempts: [],
        },
      },
    ]);
  });

  it('freezes mutable queue entries at publication call time', async () => {
    const emitted = [];
    let releaseLookup;
    let lookupStarted;
    const lookupStartedPromise = new Promise((resolve) => {
      lookupStarted = resolve;
    });
    const messageStore = {
      getById: async () => {
        lookupStarted();
        await new Promise((resolve) => {
          releaseLookup = resolve;
        });
        return null;
      },
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const entry = makeEntry({ delivery: { notifiedAt: 2 } });

    const publication = emitQueueUpdated(socketManager, 'u1', 't1', [entry], messageStore, 'frozen');
    await lookupStartedPromise;
    entry.target = { kind: 'cat', catId: 'codex' };
    entry.delivery.notifiedAt = 3;
    releaseLookup();
    await publication;

    assert.deepEqual(emitted[0].queue[0].targetCats, ['opus']);
    assert.deepEqual(emitted[0].queue[0].targetStates, { opus: 'notified' });
  });

  it('falls back to a projected raw snapshot after the enrichment deadline and releases the tail', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const emitted = [];
    let lookupStarted;
    const lookupStartedPromise = new Promise((resolve) => {
      lookupStarted = resolve;
    });
    const messageStore = {
      getById: async () => {
        lookupStarted();
        return new Promise(() => {});
      },
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const stalledEntry = makeEntry({
      id: 'stalled',
      payload: { sourceId: 'msg-stalled', content: 'stalled work', messageId: 'msg-stalled' },
    });
    let stalledSettled = false;
    let followingSettled = false;

    const stalled = emitQueueUpdated(socketManager, 'u1', 't1', [stalledEntry], messageStore, 'stalled').then(() => {
      stalledSettled = true;
    });
    await lookupStartedPromise;
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], messageStore, 'following').then(() => {
      followingSettled = true;
    });

    t.mock.timers.tick(2_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stalledSettled, true, 'deadline must settle the stalled head publication');
    assert.equal(followingSettled, true, 'deadline must release the next same-scope publication');
    await Promise.all([stalled, following]);
    assert.deepEqual(
      emitted.map((event) => ({ action: event.action, targetStates: event.queue[0]?.targetStates })),
      [
        { action: 'stalled', targetStates: { opus: 'queued' } },
        { action: 'following', targetStates: undefined },
      ],
    );
  });

  it('keeps timely message enrichment for an unassigned canonical row', async () => {
    const emitted = [];
    const messageStore = {
      getById: async () => ({
        contentBlocks: [{ kind: 'text', text: 'preview text' }],
        replyTo: 'msg-parent',
      }),
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };
    const unassignedEntry = makeEntry({ target: { kind: 'unassigned' } });

    await emitQueueUpdated(socketManager, 'u1', 't1', [unassignedEntry], messageStore, 'enriched');

    assert.deepEqual(emitted[0].queue[0].messagePreview, {
      contentBlocks: [{ kind: 'text', text: 'preview text' }],
      replyTo: 'msg-parent',
    });
    assert.deepEqual(emitted[0].queue[0].targetStates, {});
  });

  it('publishes message-bound terminal receipts after withdrawal empties the Queue', async () => {
    const emitted = [];
    const terminalEntry = makeWithdrawnLedgerEntry({
      payload: { sourceId: 'msg-withdrawn', messageId: 'msg-withdrawn', content: 'withdrawn body' },
    });
    const receiptSource = {
      getDurableEntriesForMessages: async (_threadId, messageIds) =>
        new Map(messageIds.includes('msg-withdrawn') ? [['msg-withdrawn', [terminalEntry]]] : []),
    };
    const socketManager = {
      emitToUser: (_userId, _event, data) => emitted.push(data),
    };

    await emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'removed', {
      receiptMessageIds: ['msg-withdrawn', 'msg-withdrawn', 'msg-missing'],
      receiptSource,
    });

    assert.deepEqual(emitted, [
      {
        threadId: 't1',
        queue: [],
        action: 'removed',
        messageReceipts: [
          {
            messageId: 'msg-withdrawn',
            queueReceipt: {
              version: 1,
              entryId: 'msg-withdrawn',
              targets: [
                {
                  catId: 'opus',
                  state: 'withdrawn',
                  withdrawnAt: 20,
                  attempts: [
                    {
                      id: 'withdrawn-entry:1',
                      targetCatId: 'opus',
                      sequence: 1,
                      state: 'cancelled',
                      createdAt: 1,
                      updatedAt: 20,
                      terminalReason: 'source_withdrawn',
                    },
                  ],
                },
              ],
              reminderAttempts: [],
            },
          },
        ],
      },
    ]);
  });

  it('does not poison a same-scope successor when the previous emitter throws', async () => {
    const emitted = [];
    let failFirst = true;
    const socketManager = {
      emitToUser: (_userId, _event, data) => {
        if (failFirst) {
          failFirst = false;
          throw new Error('synthetic emit failure');
        }
        emitted.push(data.action);
      },
    };

    const failed = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'first');
    const following = emitQueueUpdated(socketManager, 'u1', 't1', [], null, 'second');

    await assert.rejects(failed, /synthetic emit failure/);
    await following;
    assert.deepEqual(emitted, ['second']);
  });
});
