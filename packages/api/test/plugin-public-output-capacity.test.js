import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

const sourceMessageId = '0000000000000001-000001-11111111';
const scope = { userId: 'owner', threadId: 'capacity-thread', catId: 'astra' };
function pending(n = 2) {
  const id = `${String(n).padStart(16, '0')}-000001-22222222`,
    child = `child-${n}`;
  const boundary = {
    v: 1,
    ...scope,
    sourceMessageId,
    turnInvocationId: child,
    cursor: cursorFor({ ...scope, catId: null, id: sourceMessageId, timestamp: 1, visibilitySeq: 1 }),
  };
  return {
    ...scope,
    reservedId: id,
    timestamp: n,
    content: 'answer',
    mentions: [],
    origin: 'stream',
    replyTo: sourceMessageId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: child },
      causal: { kind: 'invocation_reply', triggerMessageId: sourceMessageId },
      publicOutputV1: {
        v: 1,
        state: 'pending_terminal',
        sourceMessageId,
        childInvocationId: child,
        outputMessageId: id,
        boundary,
      },
    },
  };
}
const ordinary = (n) => ({ ...scope, timestamp: n, content: `ordinary ${n}`, mentions: [] });
const page = (store) => store.scanPendingPublicInvocationOutputs({ limit: 100 });
function invoke(store, method, input) {
  return method === 'appendIfThreadFrontier'
    ? store[method](input, store.getLatestThreadMessageIdIncludingQueued(scope.threadId))
    : store[method](input);
}
const capacity = (error) => error.code === 'PUBLIC_OUTPUT_CAPACITY';

test('capacity control ordinary messages retain existing bounded FIFO behavior', () => {
  const store = new MessageStore({ maxMessages: 2 });
  for (let n = 1; n <= 5; n++) store.append(ordinary(n));
  assert.equal(store.size, 2);
  assert.deepEqual(
    store.getRecent(10).map((m) => m.content),
    ['ordinary 4', 'ordinary 5'],
  );
});
test('capacity control one pending output has readable owned recovery', () => {
  const store = new MessageStore({ maxMessages: 1 }),
    input = pending();
  store.append(input);
  assert.equal(store.size, 1);
  assert.equal(store.readPublicInvocationOutputRecovery(input.reservedId).kind, 'pending');
  assert.deepEqual(page(store).ids, [input.reservedId]);
});
for (const method of ['append', 'appendIdempotent']) {
  test(`full pending capacity rejects public ${method} before all mutations`, () => {
    let publications = 0;
    const store = new MessageStore({ maxMessages: 1, onAppend: () => publications++ }),
      first = pending();
    store.append(first);
    const before = store.getById(first.reservedId),
      beforePage = page(store),
      beforeCp = store.getPublicInvocationOutputRecoveryCheckpoint();
    const input = { ...pending(3), idempotencyKey: 'rejected' };
    assert.throws(() => store[method](input), capacity, 'full pending capacity must apply backpressure');
    assert.equal(store.size, 1);
    assert.deepEqual(store.getById(first.reservedId), before);
    assert.deepEqual(page(store), beforePage);
    assert.deepEqual(store.getPublicInvocationOutputRecoveryCheckpoint(), beforeCp);
    assert.equal(store.getById(input.reservedId), null);
    assert.equal(store.getByIdempotencyKey(scope.userId, scope.threadId, 'rejected'), null);
    assert.equal(publications, 1);
    store.transitionPublicInvocationOutput(first.reservedId, { expected: first, nextState: 'abandoned' });
    const admitted = store.appendIdempotent(input);
    assert.equal(admitted.idempotent, false);
    assert.equal(page(store).nextCursor, 'public-output:2', 'failed admission must not consume recovery sequence');
    assert.equal(store.size, 1);
  });
}
for (const method of ['append', 'appendIdempotent', 'appendIfThreadFrontier', 'appendAndObservePriorFrontier']) {
  test(`full pending capacity rejects ordinary ${method} without reporting a discarded write`, () => {
    const store = new MessageStore({ maxMessages: 1 }),
      input = pending();
    store.append(input);
    assert.throws(
      () => invoke(store, method, ordinary(3)),
      capacity,
      'ordinary writes must not bypass pinned pending capacity',
    );
    assert.equal(store.size, 1);
    assert.equal(store.getById(input.reservedId).content, 'answer');
    assert.deepEqual(page(store).ids, [input.reservedId]);
  });
}
for (const state of ['committed', 'abandoned']) {
  test(`capacity can reclaim ${state} output and all attached indexes`, () => {
    const store = new MessageStore({ maxMessages: 1 }),
      input = { ...pending(), idempotencyKey: 'terminal' };
    store.append(input);
    assert.equal(
      store.transitionPublicInvocationOutput(input.reservedId, { expected: input, nextState: state }).kind,
      'updated',
    );
    const next = pending(3);
    store.append(next);
    assert.equal(store.size, 1, 'terminal outputs must not disable bounded storage');
    assert.equal(store.getById(input.reservedId), null);
    assert.equal(store.getByIdempotencyKey(scope.userId, scope.threadId, 'terminal'), null);
    assert.equal(store.visibilitySeq.has(input.reservedId), false);
    assert.deepEqual(page(store).ids, [next.reservedId]);
  });
}
for (const disposition of ['quarantine', 'softDelete', 'hardDelete']) {
  test(`capacity reclaims ${disposition} output without leaving recovery discovery`, () => {
    const store = new MessageStore({ maxMessages: 1 }),
      input = pending();
    store.append(input);
    if (disposition === 'quarantine')
      assert.equal(
        store.quarantinePublicInvocationOutput(input.reservedId, { expected: input, reason: 'missing_terminal_proof' })
          .kind,
        'updated',
      );
    else store[disposition](input.reservedId, 'owner');
    const next = pending(3);
    store.append(next);
    assert.equal(store.size, 1, 'retired outputs must not disable bounded storage');
    assert.equal(store.getById(input.reservedId), null);
    assert.deepEqual(page(store).ids, [next.reservedId]);
    assert.equal(store.restore(input.reservedId), null);
  });
}
test('capacity mixes ordinary and public while retaining unresolved pending rows', () => {
  const store = new MessageStore({ maxMessages: 2 }),
    first = pending();
  store.append(first);
  const old = store.append(ordinary(3));
  const next = pending(4);
  store.append(next);
  assert.equal(store.size, 2);
  assert.equal(store.getById(old.id), null);
  assert.deepEqual(page(store).ids, [first.reservedId, next.reservedId]);
});
test('capacity permits matching idempotent replay when every slot is pending', () => {
  const store = new MessageStore({ maxMessages: 1 }),
    input = { ...pending(), idempotencyKey: 'existing' };
  store.append(input);
  assert.equal(store.appendIdempotent(input).idempotent, true);
  assert.equal(store.size, 1);
  assert.equal(page(store).nextCursor, 'public-output:1');
});
test('capacity bounds a sustained public burst and never loses admitted pending', () => {
  const store = new MessageStore({ maxMessages: 2 });
  let admitted = 0;
  for (let n = 2; n < 102; n++) {
    try {
      store.append(pending(n));
      admitted++;
    } catch (error) {
      assert.ok(capacity(error));
    }
    assert.ok(store.size <= 2, 'public burst must retain the configured capacity bound');
  }
  assert.equal(admitted, 2);
  assert.equal(page(store).ids.length, 2);
});
test('capacity pins malformed public recovery rather than silently evicting unproven work', () => {
  const store = new MessageStore({ maxMessages: 1 }),
    input = pending();
  store.append(input);
  store.messages[0].extra.publicOutputRecoveryV1 = null;
  assert.throws(() => store.append(pending(3)), capacity, 'malformed pending proof cannot authorize eviction');
  assert.equal(store.size, 1);
  assert.equal(store.readPublicInvocationOutputRecovery(input.reservedId).kind, 'malformed');
});
for (const maxMessages of [-1, NaN, Infinity, 1.5]) {
  test(`capacity rejects invalid maximum ${String(maxMessages)}`, () => {
    assert.throws(() => new MessageStore({ maxMessages }), RangeError, 'capacity must be a finite nonnegative integer');
  });
}
test('zero capacity rejects new public admission without creating a recovery member', () => {
  const store = new MessageStore({ maxMessages: 0 });
  assert.throws(() => store.append(pending()), capacity, 'zero capacity cannot admit a public output');
  assert.equal(store.size, 0);
  assert.deepEqual(page(store).ids, []);
});
