import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { parsePublicInvocationOutput } from '../src/domains/cats/services/stores/public-invocation-output.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';

const sourceId = '0000000000000001-000001-11111111';
const outputId = '0000000000000002-000001-22222222';
const scope = { userId: 'owner', threadId: 'public-thread', catId: 'astra' };
function fixture() {
  const source = { ...scope, catId: null, id: sourceId, timestamp: 1, visibilitySeq: 1 };
  const boundary = { v: 1, cursor: cursorFor(source), ...scope, sourceMessageId: sourceId, turnInvocationId: 'child' };
  return {
    ...scope,
    reservedId: outputId,
    timestamp: 2,
    content: 'public answer',
    mentions: ['astra'],
    origin: 'stream',
    replyTo: sourceId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child' },
      causal: { kind: 'invocation_reply', triggerMessageId: sourceId },
      publicOutputV1: {
        v: 1,
        state: 'pending_terminal',
        sourceMessageId: sourceId,
        childInvocationId: 'child',
        outputMessageId: outputId,
        boundary,
      },
    },
  };
}
const methods = ['append', 'appendIdempotent', 'appendIfThreadFrontier', 'appendAndObservePriorFrontier'];
async function invoke(store, method, input) {
  return method === 'appendIfThreadFrontier' ? store[method](input, null) : store[method](input);
}
function tamper(row) {
  Reflect.set(row.extra.publicOutputV1, 'state', 'committed');
  Reflect.set(row.extra.publicOutputV1.boundary, 'userId', 'private-owner');
  Reflect.set(row.extra.stream, 'turnInvocationId', 'other-child');
  Reflect.set(row.extra, 'deliveryBoundary', row.extra.publicOutputV1.boundary);
  Reflect.deleteProperty(row.extra, 'publicOutputV1');
  Reflect.set(row, 'content', 'changed private answer');
}
function assertUnchanged(store, expected) {
  const row = store.getById(outputId);
  assert.deepEqual(row.extra, expected.extra, 'public storage must not expose mutable receipt or identity aliases');
  assert.equal(row.content, expected.content);
}

test('pending output fixture is valid and ordinary append remains compatible', () => {
  const input = fixture();
  assert.ok(parsePublicInvocationOutput(input.extra.publicOutputV1));
  const store = new MessageStore();
  const row = store.append(input);
  assert.equal(row.id, outputId);
  assert.equal(row.extra.publicOutputV1.state, 'pending_terminal');
  assert.equal(row.extra.deliveryBoundary, undefined);
  assert.equal(store.size, 1);
  const ordinary = store.append({ ...scope, content: 'ordinary', timestamp: 3, mentions: [] });
  assert.equal(ordinary.content, 'ordinary');
  assert.equal(ordinary.extra, undefined);
});

test('pending output idempotent append returns the same exact output', () => {
  const store = new MessageStore();
  const input = { ...fixture(), idempotencyKey: 'public-output-child' };
  const first = store.appendIdempotent(input);
  const second = store.appendIdempotent(structuredClone(input));
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(store.size, 1);
});

for (const method of methods) {
  test(`memory ${method} refuses an initially committed receipt before append side effects`, async () => {
    let appended = 0;
    const store = new MessageStore({ onAppend: () => appended++ });
    const input = fixture();
    input.extra.publicOutputV1.state = 'committed';
    input.extra.deliveryBoundary = structuredClone(input.extra.publicOutputV1.boundary);
    await assert.rejects(
      () => invoke(store, method, input),
      /public.*output/i,
      'public append must reject terminal receipt creation',
    );
    assert.equal(store.size, 0);
    assert.equal(appended, 0);
  });
}
for (const method of ['appendIfThreadFrontier', 'appendAndObservePriorFrontier']) {
  test(`public pending output cannot enter ordinary ${method} freshness append`, async () => {
    const store = new MessageStore();
    await assert.rejects(
      () => invoke(store, method, fixture()),
      /public.*output/i,
      'public output cannot use ordinary frontier append',
    );
    assert.equal(store.size, 0);
  });
}

const invalid = [
  [
    'abandoned',
    (p) => {
      p.extra.publicOutputV1.state = 'abandoned';
    },
  ],
  [
    'present undefined',
    (p) => {
      p.extra.publicOutputV1 = undefined;
    },
  ],
  [
    'null marker',
    (p) => {
      p.extra.publicOutputV1 = null;
    },
  ],
  [
    'malformed marker',
    (p) => {
      p.extra.publicOutputV1 = {};
    },
  ],
  [
    'pending with installed boundary',
    (p) => {
      p.extra.deliveryBoundary = structuredClone(p.extra.publicOutputV1.boundary);
    },
  ],
  [
    'missing reserved id',
    (p) => {
      delete p.reservedId;
    },
  ],
  [
    'foreign output id',
    (p) => {
      p.extra.publicOutputV1.outputMessageId = sourceId;
    },
  ],
  [
    'foreign owner',
    (p) => {
      p.userId = 'other-owner';
    },
  ],
  [
    'foreign thread',
    (p) => {
      p.threadId = 'other-thread';
    },
  ],
  [
    'foreign cat',
    (p) => {
      p.catId = 'codex';
    },
  ],
  [
    'foreign stream child',
    (p) => {
      p.extra.stream.turnInvocationId = 'other-child';
    },
  ],
  [
    'foreign causal source',
    (p) => {
      p.extra.causal.triggerMessageId = 'other-source';
    },
  ],
  [
    'foreign reply source',
    (p) => {
      p.replyTo = 'other-source';
    },
  ],
  [
    'non-stream origin',
    (p) => {
      p.origin = 'callback';
    },
  ],
];
for (const [name, change] of invalid) {
  test(`public append rejects ${name} without publishing`, async () => {
    const store = new MessageStore();
    const input = fixture();
    change(input);
    await assert.rejects(
      async () => store.append(input),
      /public.*output/i,
      'public append requires exact pending output identity',
    );
    assert.equal(store.size, 0);
  });
}

test('public append rejects accessor identity without invoking the accessor', async () => {
  const input = fixture();
  let reads = 0;
  Object.defineProperty(input.extra.publicOutputV1, 'state', {
    enumerable: true,
    get() {
      reads++;
      return 'pending_terminal';
    },
  });
  const store = new MessageStore();
  await assert.rejects(
    async () => store.append(input),
    /public.*output/i,
    'public append must snapshot own data before normalization',
  );
  assert.equal(reads, 0);
  assert.equal(store.size, 0);
});

test('public idempotency replay cannot return an ordinary row under the same token', async () => {
  const store = new MessageStore();
  store.append({ ...scope, content: 'ordinary', timestamp: 1, mentions: [], idempotencyKey: 'same' });
  const input = { ...fixture(), idempotencyKey: 'same' };
  await assert.rejects(
    async () => store.appendIdempotent(input),
    /public.*output/i,
    'public idempotency must verify existing output identity',
  );
  assert.equal(store.size, 1);
});

test('ordinary idempotency replay cannot acquire a public row under the same token', async () => {
  const store = new MessageStore();
  store.append({ ...fixture(), idempotencyKey: 'same' });
  await assert.rejects(
    async () =>
      store.appendIdempotent({ ...scope, content: 'ordinary', timestamp: 3, mentions: [], idempotencyKey: 'same' }),
    /public.*output/i,
    'ordinary idempotency cannot alias public identity',
  );
  assert.equal(store.size, 1);
});

const readers = [
  ['getById', (s) => s.getById(outputId)],
  ['getRecent', (s) => s.getRecent()[0]],
  ['getByThread', (s) => s.getByThread(scope.threadId)[0]],
  ['getByThreadIncludingQueued', (s) => s.getByThreadIncludingQueued(scope.threadId)[0]],
  ['getByThreadAfter', (s) => s.getByThreadAfter(scope.threadId)[0]],
  [
    'getByThreadAfter raw timeline',
    (s) => s.getByThreadAfter(scope.threadId, undefined, 10, scope.userId, { includeQueuedUserMessages: true })[0],
  ],
  ['getBefore', (s) => s.getBefore(3)[0]],
  ['getByThreadBefore', (s) => s.getByThreadBefore(scope.threadId, 3)[0]],
  [
    'getByThreadBeforeBounded',
    (s) => s.getByThreadBeforeBounded(scope.threadId, 3, 10, undefined, scope.userId, 10).messages[0],
  ],
  ['getMentionsFor', (s) => s.getMentionsFor('astra')[0]],
  ['getRecentMentionsFor', (s) => s.getRecentMentionsFor('astra')[0]],
  ['listOwnerMessagesInWindow', (s) => s.listOwnerMessagesInWindow(scope.userId, 0, 3)[0]],
  ['listOwnerMessageWindowSlice', (s) => s.listOwnerMessageWindowSlice(scope.userId, 0, 3, 10).messages[0]],
  ['idempotent replay', (s) => s.appendIdempotent({ ...fixture(), idempotencyKey: 'same' }).message],
];
for (const [name, read] of readers) {
  test(`memory public ${name} cannot mutate stored receipt or output identity`, () => {
    const store = new MessageStore();
    const input = { ...fixture(), idempotencyKey: 'same' };
    store.append(input);
    const expected = structuredClone(input);
    const row = read(store);
    assert.equal(row.id, outputId, 'reader fixture must reach the actual output');
    tamper(row);
    assertUnchanged(store, expected);
  });
}
for (const from of ['input', 'returned row', 'append listener']) {
  test(`memory public ${from} cannot retain mutable storage aliases`, () => {
    let observed;
    const store = new MessageStore({
      onAppend: (row) => {
        observed = row;
      },
    });
    const input = fixture();
    const expected = structuredClone(input);
    const stored = store.append(input);
    tamper(from === 'input' ? input : from === 'returned row' ? stored : observed);
    assertUnchanged(store, expected);
  });
}

for (const method of methods) {
  test(`Redis ${method} rejects terminal public creation before any Redis command`, async () => {
    let calls = 0;
    const redis = new Proxy(
      { options: {} },
      {
        get(target, key) {
          if (key in target) return target[key];
          return () => {
            calls++;
            throw new Error('unexpected fake Redis access');
          };
        },
      },
    );
    const store = new RedisMessageStore(redis);
    const input = fixture();
    input.extra.publicOutputV1.state = 'committed';
    await assert.rejects(
      () => invoke(store, method, input),
      /public.*output/i,
      'public input must be rejected before Redis I/O',
    );
    assert.equal(calls, 0);
  });
}

for (const [name, read] of readers.filter(([name]) => name !== 'idempotent replay')) {
  test(`ordinary ${name} snapshot cannot inject public identity into storage`, () => {
    const store = new MessageStore();
    const input = fixture();
    delete input.extra.publicOutputV1;
    store.append(input);
    const row = read(store);
    assert.equal(row.id, outputId);
    Reflect.set(row.extra, 'publicOutputV1', fixture().extra.publicOutputV1);
    Reflect.set(row, 'extra', fixture().extra);
    assert.equal(store.getById(outputId).extra.publicOutputV1, undefined);
  });
}
for (const from of ['input', 'returned row', 'append listener']) {
  test(`ordinary ${from} snapshot cannot inject public identity into storage`, () => {
    let observed;
    const store = new MessageStore({
      onAppend: (row) => {
        observed = row;
      },
    });
    const input = fixture();
    delete input.extra.publicOutputV1;
    const row = store.append(input);
    Reflect.set(
      from === 'input' ? input.extra : from === 'returned row' ? row.extra : observed.extra,
      'publicOutputV1',
      fixture().extra.publicOutputV1,
    );
    assert.equal(store.getById(outputId).extra.publicOutputV1, undefined);
  });
}

for (const change of [
  (input) => {
    input.content = 'other body';
  },
  (input) => {
    input.extra.publicOutputV1.boundary.cursor = `v2:0000000000000002:${sourceId}`;
  },
]) {
  test('public replay rejects a different body or source cursor without a second append', async () => {
    const store = new MessageStore();
    const input = { ...fixture(), idempotencyKey: 'same' };
    store.append(input);
    change(input);
    await assert.rejects(async () => store.appendIdempotent(input), /public.*output/i);
    assert.equal(store.size, 1);
  });
}

for (const method of ['appendIfThreadFrontier', 'appendAndObservePriorFrontier']) {
  test(`ordinary ${method} replay cannot return public output`, async () => {
    const store = new MessageStore();
    store.append({ ...fixture(), idempotencyKey: 'same' });
    const input = { ...scope, content: 'ordinary', timestamp: 3, mentions: [], idempotencyKey: 'same' };
    await assert.rejects(() => invoke(store, method, input), /public.*output/i);
    assert.equal(store.size, 1);
  });
}

test('Redis public append snapshots receipt and body before its first idempotency await', async () => {
  let release;
  const waiting = new Promise((r) => {
    release = r;
  });
  let argv;
  const store = new RedisMessageStore({
    options: {},
    get: () => waiting,
    eval: async (...args) => {
      argv = args;
      return 9;
    },
  });
  store.ensureVisibilityMigrated = async () => {};
  const input = { ...fixture(), idempotencyKey: 'same' };
  const pending = store.appendIdempotent(input);
  input.content = 'private pollution';
  input.extra.publicOutputV1.boundary.userId = 'foreign';
  release(null);
  const result = await pending;
  assert.equal(result.message.content, 'public answer');
  assert.equal(result.message.extra.publicOutputV1.boundary.userId, 'owner');
  assert.equal(argv.includes('private pollution'), false);
  assert.equal(result.idempotent, false);
});

for (const winnerAt of ['early read', 'atomic append']) {
  test(`Redis public replay rejects an ordinary winner from ${winnerAt}`, async () => {
    const ordinary = { ...scope, id: sourceId, content: 'ordinary', timestamp: 1, mentions: [] };
    const store = new RedisMessageStore({
      options: {},
      get: async () => (winnerAt === 'early read' ? sourceId : null),
      eval: async () => sourceId,
    });
    store.ensureVisibilityMigrated = async () => {};
    store.getById = async () => structuredClone(ordinary);
    await assert.rejects(
      async () => store.appendIdempotent({ ...fixture(), idempotencyKey: 'same' }),
      /public.*output/i,
    );
  });
}

for (const method of ['softDelete', 'restore', 'markDelivered', 'markCanceled']) {
  test(`memory ${method} result cannot bypass public storage ownership`, () => {
    const store = new MessageStore();
    store.append(fixture());
    if (method === 'restore') store.softDelete(outputId, 'owner');
    const result = store[method](outputId, method === 'markDelivered' ? 3 : 'owner');
    assert.ok(result);
    const before = store.getById(outputId);
    tamper(result);
    assert.deepEqual(store.getById(outputId), before);
  });
}
