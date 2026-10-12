import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { committedPublicInvocationOutput } from '../src/domains/cats/services/stores/public-invocation-output.ts';
import { createPublicOutputRecovery } from '../src/domains/cats/services/stores/public-invocation-output-recovery.ts';
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
    mentions: [],
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
function setup() {
  let publications = 0;
  const store = new MessageStore({ onAppend: () => publications++ });
  store.append({ ...fixture(), idempotencyKey: 'output-token' });
  return { store, publications: () => publications };
}
function transition(store) {
  assert.equal(
    typeof store.transitionPublicInvocationOutput,
    'function',
    'missing atomic public output terminal transition',
  );
  return store.transitionPublicInvocationOutput.bind(store);
}
const request = (nextState = 'committed') => ({ expected: fixture(), nextState });
function assertPending(store) {
  const row = store.getById(outputId);
  assert.equal(row.extra.publicOutputV1.state, 'pending_terminal');
  assert.equal(Object.hasOwn(row.extra, 'deliveryBoundary'), false);
}
function hashFixture() {
  const input = fixture();
  const { reservedId, extra, mentions, ...rest } = input;
  return {
    ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])),
    id: reservedId,
    contentBlocks: '',
    toolEvents: '',
    metadata: '',
    mentions: JSON.stringify(mentions),
    extra: JSON.stringify({ ...extra, publicOutputRecoveryV1: createPublicOutputRecovery(input) }),
  };
}
function flatten(hash) {
  return Object.entries(hash).flat();
}

test('terminal CAS fixture is a valid pending output without committed evidence', () => {
  const { store, publications } = setup();
  assertPending(store);
  assert.equal(committedPublicInvocationOutput(store.getById(outputId)), undefined);
  assert.equal(publications(), 1);
});
for (const state of ['committed', 'abandoned']) {
  test(`public output CAS installs ${state} atomically without another append`, async () => {
    const { store, publications } = setup();
    const update = transition(store);
    const before = store.getById(outputId);
    const result = await update(outputId, request(state));
    assert.equal(result.kind, 'updated');
    const current = store.getById(outputId);
    const expected = structuredClone(before);
    expected.extra.publicOutputV1.state = state;
    delete expected.extra.publicOutputRecoveryV1;
    if (state === 'committed') expected.extra.deliveryBoundary = expected.extra.publicOutputV1.boundary;
    assert.deepEqual(current, expected);
    assert.deepEqual(result.message, current);
    assert.equal(Boolean(committedPublicInvocationOutput(current)), state === 'committed');
    assert.equal(publications(), 1);
    assert.equal(store.size, 1);
  });
  test(`public output CAS ${state} replay is idempotent and returns detached truth`, async () => {
    const { store } = setup();
    const update = transition(store);
    await update(outputId, request(state));
    const before = store.getById(outputId);
    const result = await update(outputId, request(state));
    assert.equal(result.kind, 'existing');
    Reflect.set(result.message.extra.publicOutputV1, 'state', 'pending_terminal');
    Reflect.set(result.message, 'content', 'polluted');
    assert.deepEqual(store.getById(outputId), before);
    assert.equal(
      store.appendIdempotent({ ...fixture(), idempotencyKey: 'output-token' }).message.extra.publicOutputV1.state,
      state,
    );
  });
  test(`public output CAS cannot reverse ${state} to the other terminal`, async () => {
    const { store } = setup();
    const update = transition(store);
    await update(outputId, request(state));
    const before = store.getById(outputId);
    assert.equal((await update(outputId, request(state === 'committed' ? 'abandoned' : 'committed'))).kind, 'conflict');
    assert.deepEqual(store.getById(outputId), before);
  });
}
test('public output CAS permits exactly one conflicting terminal winner', async () => {
  const { store } = setup();
  const update = transition(store);
  const results = await Promise.all([update(outputId, request()), update(outputId, request('abandoned'))]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ['conflict', 'updated']);
  assert.equal(store.getById(outputId).extra.publicOutputV1.state, 'committed');
});
test('public output CAS missing output does not create a row', async () => {
  const store = new MessageStore();
  const update = transition(store);
  assert.equal((await update(outputId, request())).kind, 'not_found');
  assert.equal(store.size, 0);
});
test('public output CAS never attaches a public identity to ordinary output', async () => {
  const store = new MessageStore();
  const update = transition(store);
  const input = fixture();
  delete input.extra.publicOutputV1;
  store.append(input);
  const before = store.getById(outputId);
  assert.equal((await update(outputId, request())).kind, 'conflict');
  assert.deepEqual(store.getById(outputId), before);
});
for (const [name, mutate] of [
  [
    'body',
    (x) => {
      x.content = 'other body';
    },
  ],
  [
    'timestamp',
    (x) => {
      x.timestamp = 3;
    },
  ],
  [
    'parent stream',
    (x) => {
      x.extra.stream.invocationId = 'other-parent';
    },
  ],
  [
    'source cursor',
    (x) => {
      x.extra.publicOutputV1.boundary.cursor = `v2:0000000000000002:${sourceId}`;
    },
  ],
  [
    'owner',
    (x) => {
      x.userId = x.extra.publicOutputV1.boundary.userId = 'foreign';
    },
  ],
  [
    'thread',
    (x) => {
      x.threadId = x.extra.publicOutputV1.boundary.threadId = 'foreign';
    },
  ],
  [
    'child',
    (x) => {
      x.extra.stream.turnInvocationId =
        x.extra.publicOutputV1.childInvocationId =
        x.extra.publicOutputV1.boundary.turnInvocationId =
          'other-child';
    },
  ],
]) {
  test(`public output CAS rejects stale ${name} without changing pending state`, async () => {
    const { store } = setup();
    const update = transition(store);
    const input = request();
    mutate(input.expected);
    assert.equal((await update(outputId, input)).kind, 'conflict');
    assertPending(store);
  });
}
for (const mutation of ['softDelete', 'hardDelete', 'prepareQueueAdmission']) {
  test(`public output CAS fails closed after ${mutation}`, async () => {
    const { store } = setup();
    const update = transition(store);
    store[mutation](outputId, 'owner');
    const before = store.getById(outputId);
    assert.equal((await update(outputId, request())).kind, 'conflict');
    assert.deepEqual(store.getById(outputId), before);
  });
}
const malformed = [
  [
    'pending next state',
    (x) => {
      x.nextState = 'pending_terminal';
    },
  ],
  [
    'unknown next state',
    (x) => {
      x.nextState = 'succeeded';
    },
  ],
  [
    'unknown request field',
    (x) => {
      x.authorized = true;
    },
  ],
  [
    'terminal expected receipt',
    (x) => {
      x.expected.extra.publicOutputV1.state = 'committed';
    },
  ],
  [
    'expected installed boundary',
    (x) => {
      x.expected.extra.deliveryBoundary = x.expected.extra.publicOutputV1.boundary;
    },
  ],
  [
    'missing expected marker',
    (x) => {
      delete x.expected.extra.publicOutputV1;
    },
  ],
];
for (const [name, mutate] of malformed) {
  for (const backend of ['memory', 'Redis']) {
    test(`${backend} public output CAS rejects ${name} before storage access`, async () => {
      let calls = 0;
      const redis = new Proxy(
        { options: {} },
        {
          get(target, key) {
            if (key in target) return target[key];
            return () => {
              calls++;
              throw Error('unexpected Redis access');
            };
          },
        },
      );
      const store = backend === 'memory' ? setup().store : new RedisMessageStore(redis);
      const update = transition(store);
      const input = request();
      mutate(input);
      await assert.rejects(async () => update(outputId, input), /public.*output/i);
      assert.equal(calls, 0);
      if (backend === 'memory') assertPending(store);
    });
  }
}
test('public output CAS rejects accessor request without invoking it', async () => {
  const { store } = setup();
  const update = transition(store);
  let calls = 0;
  const input = request();
  Object.defineProperty(input, 'nextState', {
    get() {
      calls++;
      return 'committed';
    },
    enumerable: true,
  });
  await assert.rejects(async () => update(outputId, input), /public.*output/i);
  assert.equal(calls, 0);
  assertPending(store);
});
test('public output CAS refuses a different API output id', async () => {
  const { store } = setup();
  const update = transition(store);
  await assert.rejects(async () => update(sourceId, request()), /public.*output/i);
  assertPending(store);
});
test('Redis public output CAS freezes input before its first storage await', async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  let evals = 0;
  const store = new RedisMessageStore({
    options: {},
    hgetall: () => waiting,
    eval: async () => {
      evals++;
      return [0];
    },
  });
  const update = transition(store);
  const input = request();
  const pending = update(outputId, input);
  input.expected.content = 'private pollution';
  input.nextState = 'abandoned';
  release(hashFixture());
  assert.equal((await pending).kind, 'conflict');
  assert.equal(evals, 1);
});
test('Redis public output CAS does not retry a concurrent conflict', async () => {
  let reads = 0,
    evals = 0;
  const store = new RedisMessageStore({
    options: {},
    hgetall: async () => {
      reads++;
      return hashFixture();
    },
    eval: async () => {
      evals++;
      return [0];
    },
  });
  assert.equal((await transition(store)(outputId, request())).kind, 'conflict');
  assert.equal(reads, 1);
  assert.equal(evals, 1);
});
test('Redis public output CAS propagates storage failure without success', async () => {
  const store = new RedisMessageStore({
    options: {},
    hgetall: async () => hashFixture(),
    eval: async () => {
      throw Error('injected CAS outage');
    },
  });
  await assert.rejects(() => transition(store)(outputId, request()), /injected CAS outage/);
});
test('Redis public output CAS returns atomic canonical output without a post-write read', async () => {
  const hash = hashFixture();
  let reads = 0,
    evals = 0;
  const store = new RedisMessageStore({
    options: {},
    hgetall: async () => {
      reads++;
      assert.equal(reads, 1);
      return hash;
    },
    eval: async () => {
      evals++;
      const extra = JSON.parse(hash.extra);
      extra.publicOutputV1.state = 'committed';
      delete extra.publicOutputRecoveryV1;
      extra.deliveryBoundary = extra.publicOutputV1.boundary;
      return [1, ...flatten({ ...hash, extra: JSON.stringify(extra) })];
    },
  });
  const result = await transition(store)(outputId, request());
  assert.equal(result.kind, 'updated');
  assert.ok(committedPublicInvocationOutput(result.message));
  assert.equal(reads, 1);
  assert.equal(evals, 1);
});

for (const [field, value] of [
  ['recall', '{broken'],
  ['_tombstone', 'invalid'],
  ['deletedAt', 'not-a-number'],
  ['queueCustody', '{broken'],
  ['queueCustodyAdmission', '{broken'],
  ['deliveryStatus', ''],
  ['metadata', '{broken'],
  ['contentBlocks', '{broken'],
  ['toolEvents', '{broken'],
  ['mentions', '{broken'],
  ['mentions', ''],
]) {
  test(`Redis terminal CAS refuses malformed raw ${field} before eval`, async () => {
    let evals = 0;
    const store = new RedisMessageStore({
      options: {},
      hgetall: async () => ({ ...hashFixture(), [field]: value }),
      eval: async () => {
        evals++;
        throw Error('must not CAS');
      },
    });
    assert.equal((await transition(store)(outputId, request())).kind, 'conflict');
    assert.equal(evals, 0);
  });
}
for (const value of [null, {}, { v: 1 }, { ...fixture().extra.publicOutputV1, state: 'invalid' }]) {
  test('Redis terminal CAS refuses malformed persisted public receipt', async () => {
    const hash = hashFixture();
    const extra = JSON.parse(hash.extra);
    extra.publicOutputV1 = value;
    hash.extra = JSON.stringify(extra);
    const store = new RedisMessageStore({
      options: {},
      hgetall: async () => hash,
      eval: async () => {
        throw Error('must not CAS');
      },
    });
    assert.equal((await transition(store)(outputId, request())).kind, 'conflict');
  });
}
test('Redis terminal CAS fences all raw fields and preserves unknown extra siblings', async () => {
  const hash = hashFixture();
  const extra = JSON.parse(hash.extra);
  extra.futureSibling = { protected: true };
  const expectedInput = fixture();
  expectedInput.extra.futureSibling = extra.futureSibling;
  extra.publicOutputRecoveryV1 = createPublicOutputRecovery(expectedInput);
  hash.extra = JSON.stringify(extra);
  let evals = 0;
  const store = new RedisMessageStore({
    options: {},
    hgetall: async () => hash,
    eval: async (_script, keyCount, _key, _index, expectedJson, nextExtra) => {
      evals++;
      assert.equal(keyCount, 2);
      assert.deepEqual(Object.fromEntries(JSON.parse(expectedJson)), hash);
      const written = JSON.parse(nextExtra);
      assert.deepEqual(written.futureSibling, extra.futureSibling);
      assert.equal(written.publicOutputV1.state, 'committed');
      assert.deepEqual(written.deliveryBoundary, fixture().extra.publicOutputV1.boundary);
      return [1, ...flatten({ ...hash, extra: nextExtra })];
    },
  });
  assert.equal(
    (await transition(store)(outputId, { expected: expectedInput, nextState: 'committed' })).kind,
    'updated',
  );
  assert.equal(evals, 1);
});
test('Redis terminal replay still atomically fences its canonical no-op receipt', async () => {
  const hash = hashFixture();
  const extra = JSON.parse(hash.extra);
  extra.publicOutputV1.state = 'committed';
  delete extra.publicOutputRecoveryV1;
  extra.deliveryBoundary = extra.publicOutputV1.boundary;
  hash.extra = JSON.stringify(extra);
  let evals = 0;
  const store = new RedisMessageStore({
    options: {},
    hgetall: async () => hash,
    eval: async (_script, _n, _key, _index, expected, next) => {
      evals++;
      assert.deepEqual(Object.fromEntries(JSON.parse(expected)), hash);
      assert.equal(next, '');
      return [2, ...flatten(hash)];
    },
  });
  assert.equal((await transition(store)(outputId, request())).kind, 'existing');
  assert.equal(evals, 1);
});
for (const receipt of [[], [99], [1, 'id'], [1, ...flatten(hashFixture())]]) {
  test('Redis terminal CAS never reports success from a malformed or nonterminal atomic receipt', async () => {
    const store = new RedisMessageStore({ options: {}, hgetall: async () => hashFixture(), eval: async () => receipt });
    await assert.rejects(() => transition(store)(outputId, request()), /Public output CAS/);
  });
}
test('terminal CAS success isolates input and result from canonical storage', async () => {
  const { store } = setup();
  const input = request();
  const result = await transition(store)(outputId, input);
  const before = store.getById(outputId);
  input.expected.extra.publicOutputV1.boundary.userId = 'foreign';
  Reflect.set(result.message.extra.deliveryBoundary, 'userId', 'foreign');
  Reflect.set(result.message.extra.publicOutputV1.boundary, 'userId', 'foreign');
  assert.deepEqual(store.getById(outputId), before);
});

for (const [field, value] of [
  ['contentBlocks', [{ type: 'text', text: 'expected rich body' }]],
  ['toolEvents', [{ id: 'event', type: 'tool_use', name: 'test' }]],
  ['metadata', { source: 'expected metadata' }],
]) {
  test(`Redis terminal CAS cannot substitute empty raw ${field} for expected data`, async () => {
    let evals = 0;
    const store = new RedisMessageStore({
      options: {},
      hgetall: async () => hashFixture(),
      eval: async () => {
        evals++;
        throw Error('must not CAS');
      },
    });
    const input = request();
    input.expected[field] = value;
    assert.equal((await transition(store)(outputId, input)).kind, 'conflict');
    assert.equal(evals, 0);
  });
}
