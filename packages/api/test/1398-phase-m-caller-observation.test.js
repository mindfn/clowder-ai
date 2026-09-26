// F117 Phase M: a cat that appended to another cat's running turn sees "awaiting_read" until the target
// read it, is told again once it was read, and sees "unread" when the target's run ended first.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);

const scope = { ownerId: 'owner-1', threadId: 'thread-1', callerCatId: 'caller' };

function source(ref) {
  return {
    id: 'source-append',
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: scope.callerCatId },
    content: 'also check the flaky test',
    timestamp: 1,
    lifecycle: { kind: 'input', orderKey: '1:source-append', dispatchRefs: [ref] },
  };
}

function response(status, lists) {
  return {
    id: 'response-worker',
    threadId: scope.threadId,
    userId: scope.ownerId,
    from: { kind: 'agent', catId: 'worker' },
    content: status === 'processing' ? '' : 'done without it',
    timestamp: 2,
    lifecycle: {
      kind: 'response',
      orderKey: '2:response-worker',
      invocationId: 'inv-worker',
      targetId: 'worker',
      inputEntryIds: ['entry-first'],
      inputMessageIds: ['message-first'],
      ...lists,
      status,
      startedAt: 1,
      ...(status === 'processing' ? {} : { completedAt: 3 }),
    },
  };
}

const ref = (extra) => ({ targetId: 'worker', statusMessageId: 'response-worker', dispatchedAt: 2, ...extra });

async function project(registry, messages) {
  return registry.project({ getById: async (id) => messages.get(id) ?? null }, scope);
}

describe('F117 Phase M caller dispatch observations', () => {
  it('reports a handed Append as awaiting_read, then again as executing once it was read', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const handedSource = source(ref({ phase: 'dispatched', readState: 'awaiting' }));
    const handed = response('processing', {
      handedInputEntryIds: ['entry-append'],
      handedInputMessageIds: [handedSource.id],
    });
    registry.registerPersistedSource(handedSource, ['worker']);
    let projection = await project(
      registry,
      new Map([
        [handedSource.id, handedSource],
        [handed.id, handed],
      ]),
    );
    assert.match(projection.prompt, /source-append → worker: awaiting_read/);
    assert.equal(projection.included[0]?.terminal, false);
    registry.acknowledge(projection.included);

    const readSource = source(ref({ phase: 'dispatched', readAt: 5 }));
    const read = response('processing', {
      inputEntryIds: ['entry-first', 'entry-append'],
      inputMessageIds: ['message-first', readSource.id],
    });
    registry.registerPersistedSource(readSource, ['worker']);
    projection = await project(
      registry,
      new Map([
        [readSource.id, readSource],
        [read.id, read],
      ]),
    );
    assert.match(projection.prompt, /source-append → worker: executing/, 'the read is news to the caller');
  });

  it('reports an Append the target never read as a terminal unread', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const unreadSource = source(ref({ phase: 'settled', readState: 'unread' }));
    const ended = response('canceled', {
      handedInputEntryIds: ['entry-append'],
      handedInputMessageIds: [unreadSource.id],
    });
    registry.registerPersistedSource(unreadSource, ['worker']);
    const projection = await project(
      registry,
      new Map([
        [unreadSource.id, unreadSource],
        [ended.id, ended],
      ]),
    );
    assert.match(projection.prompt, /source-append → worker: unread\(canceled\); response=response-worker/);
    assert.equal(projection.included[0]?.terminal, true);
  });

  it('does not trust an unread ref the response does not index', async () => {
    const registry = new CallerDispatchObservationRegistry();
    const unreadSource = source(ref({ phase: 'settled', readState: 'unread' }));
    const ended = response('completed', {});
    registry.registerPersistedSource(unreadSource, ['worker']);
    const projection = await project(
      registry,
      new Map([
        [unreadSource.id, unreadSource],
        [ended.id, ended],
      ]),
    );
    assert.match(projection.prompt, /unknown/);
    assert.equal(projection.included[0]?.terminal, false);
  });
});
