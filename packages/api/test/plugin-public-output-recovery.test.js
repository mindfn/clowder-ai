import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import {
  committedPublicInvocationOutput,
  hasPublicInvocationOutput,
} from '../src/domains/cats/services/stores/public-invocation-output.ts';
import {
  PUBLIC_OUTPUT_CHECKPOINT_LUA,
  PUBLIC_OUTPUT_DELETE_LUA,
  PUBLIC_OUTPUT_RETIRE_MISSING_LUA,
  PUBLIC_OUTPUT_THREAD_DELETE_LUA,
} from '../src/domains/cats/services/stores/redis/public-output-recovery-lua.ts';
import { TRANSITION_PUBLIC_OUTPUT_LUA } from '../src/domains/cats/services/stores/redis/public-output-terminal-lua.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { safeParseExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.ts';
import { APPEND_WITH_VISIBILITY_LUA } from '../src/domains/cats/services/stores/redis/redis-visibility-lua-scripts.ts';

const sourceId = '0000000000000001-000001-11111111';
const scope = { userId: 'owner', threadId: 'public-thread', catId: 'astra' };
function fixture(n = 2) {
  const id = `${String(n).padStart(16, '0')}-000001-22222222`;
  const child = `child-${n}`;
  const boundary = {
    v: 1,
    ...scope,
    sourceMessageId: sourceId,
    turnInvocationId: child,
    cursor: cursorFor({ ...scope, catId: null, id: sourceId, timestamp: 1, visibilitySeq: 1 }),
  };
  return {
    ...scope,
    reservedId: id,
    timestamp: n,
    content: 'public answer',
    mentions: [],
    origin: 'stream',
    replyTo: sourceId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: child },
      causal: { kind: 'invocation_reply', triggerMessageId: sourceId },
      publicOutputV1: {
        v: 1,
        state: 'pending_terminal',
        sourceMessageId: sourceId,
        childInvocationId: child,
        outputMessageId: id,
        boundary,
      },
    },
  };
}
function api(store, name) {
  assert.equal(typeof store[name], 'function', `missing owned public output recovery: ${name}`);
  return store[name].bind(store);
}
function ready(store) {
  for (const name of [
    'scanPendingPublicInvocationOutputs',
    'readPublicInvocationOutputRecovery',
    'quarantinePublicInvocationOutput',
    'getPublicInvocationOutputRecoveryCheckpoint',
    'advancePublicInvocationOutputRecoveryCheckpoint',
  ])
    api(store, name);
  return store;
}
function setup() {
  const store = new MessageStore();
  const expected = fixture();
  store.append(expected);
  return { store, expected, id: expected.reservedId };
}
const page = (store, after, limit = 100) =>
  store.scanPendingPublicInvocationOutputs({ ...(after ? { after } : {}), limit });
const quarantine = (x, reason = 'missing_terminal_proof') =>
  x.store.quarantinePublicInvocationOutput(x.id, { expected: x.expected, reason });
function rawFixture(message) {
  const raw = {
    id: message.id,
    userId: message.userId,
    threadId: message.threadId,
    catId: message.catId,
    timestamp: String(message.timestamp),
    content: message.content,
    mentions: JSON.stringify(message.mentions),
    origin: message.origin,
    replyTo: message.replyTo,
    contentBlocks: '',
    toolEvents: '',
    metadata: '',
    extra: JSON.stringify(message.extra),
    visibilitySeq: String(message.visibilitySeq),
  };
  return raw;
}
function rawStore(raw) {
  return new RedisMessageStore({ options: {}, hgetall: async () => structuredClone(raw) });
}

test('recovery fixture has valid pending identity and no committed evidence', () => {
  const x = setup();
  const row = x.store.getById(x.id);
  assert.equal(row.extra.publicOutputV1.state, 'pending_terminal');
  assert.equal(committedPublicInvocationOutput(row), undefined);
  assert.equal(row.extra.stream.turnInvocationId, row.extra.publicOutputV1.childInvocationId);
});
test('ordinary append fixture remains detached and has no public identity', () => {
  const store = new MessageStore();
  const input = fixture();
  delete input.extra.publicOutputV1;
  const row = store.append(input);
  row.content = 'mutated';
  assert.equal(store.getById(row.id).content, 'public answer');
  assert.equal(Object.hasOwn(store.getById(row.id).extra, 'publicOutputV1'), false);
});

test('pending append owns a recovery companion, digest and discovery membership', async () => {
  const x = setup();
  ready(x.store);
  const row = x.store.getById(x.id);
  assert.equal(row.extra.publicOutputRecoveryV1.state, 'pending');
  const read = await x.store.readPublicInvocationOutputRecovery(x.id);
  assert.equal(read.kind, 'pending');
  assert.deepEqual(read.expected, x.expected);
  assert.deepEqual((await page(x.store)).ids, [x.id]);
  assert.equal((await page(x.store)).exhausted, true);
});
for (const method of ['append', 'appendIdempotent']) {
  for (const lane of ['public', 'ordinary']) {
    test(`caller cannot inject recovery companion through ${lane} ${method}`, () => {
      const store = ready(new MessageStore());
      const input = fixture();
      if (lane === 'ordinary') delete input.extra.publicOutputV1;
      input.extra.publicOutputRecoveryV1 = { v: 1, state: 'pending' };
      assert.throws(() => store[method](input), /recovery/i);
      assert.equal(store.size, 0);
    });
  }
}
test('companion accessor is rejected without invoking caller code', () => {
  const store = ready(new MessageStore());
  const input = fixture();
  let reads = 0;
  Object.defineProperty(input.extra, 'publicOutputRecoveryV1', {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  assert.throws(() => store.append(input));
  assert.equal(reads, 0);
  assert.equal(store.size, 0);
});
for (const method of ['updateExtra', 'augmentStreamMetadata']) {
  test(`generic ${method} cannot create a recovery companion on ordinary output`, async () => {
    const store = ready(new MessageStore());
    const input = fixture();
    delete input.extra.publicOutputV1;
    const row = store.append(input);
    const patch = { publicOutputRecoveryV1: { v: 1, state: 'quarantined', reason: 'missing_terminal_proof' } };
    await store[method](row.id, method === 'updateExtra' ? patch : { extra: patch });
    assert.equal(Object.hasOwn(store.getById(row.id).extra, 'publicOutputRecoveryV1'), false);
  });
}
for (const state of ['committed', 'abandoned']) {
  test(`terminal ${state} removes companion/index atomically and replay keeps them absent`, async () => {
    const x = setup();
    ready(x.store);
    assert.equal(
      (await x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState: state })).kind,
      'updated',
    );
    const row = x.store.getById(x.id);
    assert.equal(Object.hasOwn(row.extra, 'publicOutputRecoveryV1'), false);
    assert.deepEqual((await page(x.store)).ids, []);
    assert.equal((await x.store.readPublicInvocationOutputRecovery(x.id)).kind, 'terminal');
    assert.equal(
      (await x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState: state })).kind,
      'existing',
    );
    assert.equal((await quarantine(x)).kind, 'terminal_won');
    assert.equal(Boolean(committedPublicInvocationOutput(row)), state === 'committed');
  });
}
test('quarantine keeps pending receipt without boundary and permanently fences terminal CAS', async () => {
  const x = setup();
  ready(x.store);
  const before = Date.now();
  const result = await quarantine(x);
  assert.equal(result.kind, 'updated');
  const row = x.store.getById(x.id);
  assert.equal(row.extra.publicOutputV1.state, 'pending_terminal');
  assert.equal(row.extra.publicOutputRecoveryV1.state, 'quarantined');
  assert.equal(row.extra.publicOutputRecoveryV1.reason, 'missing_terminal_proof');
  assert.ok(row.extra.publicOutputRecoveryV1.recordedAt >= before);
  assert.equal(Object.hasOwn(row.extra, 'deliveryBoundary'), false);
  assert.deepEqual((await page(x.store)).ids, []);
  assert.equal((await x.store.readPublicInvocationOutputRecovery(x.id)).kind, 'quarantined');
  for (const nextState of ['committed', 'abandoned'])
    assert.equal(
      (await x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState })).kind,
      'conflict',
    );
  assert.equal((await quarantine(x)).kind, 'existing');
});
for (const first of ['quarantine', 'terminal']) {
  test(`terminal versus quarantine single winner when ${first} starts first`, async () => {
    const x = setup();
    ready(x.store);
    const terminal = () =>
      x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState: 'committed' });
    const calls = first === 'quarantine' ? [() => quarantine(x), terminal] : [terminal, () => quarantine(x)];
    const results = await Promise.all(calls.map((f) => f()));
    assert.equal(results[0].kind, 'updated');
    assert.equal(results[1].kind, first === 'quarantine' ? 'conflict' : 'terminal_won');
  });
}
for (const mutation of ['body', 'child', 'caller time', 'raw reason']) {
  test(`quarantine rejects ${mutation} without changing pending recovery`, async () => {
    const x = setup();
    ready(x.store);
    const input = { expected: structuredClone(x.expected), reason: 'missing_terminal_proof' };
    if (mutation === 'body') input.expected.content = 'changed';
    if (mutation === 'child') {
      input.expected.extra.stream.turnInvocationId =
        input.expected.extra.publicOutputV1.childInvocationId =
        input.expected.extra.publicOutputV1.boundary.turnInvocationId =
          'other';
    }
    if (mutation === 'caller time') input.recordedAt = 1;
    if (mutation === 'raw reason') input.reason = 'raw secret error';
    if (mutation === 'body' || mutation === 'child')
      assert.equal((await x.store.quarantinePublicInvocationOutput(x.id, input)).kind, 'conflict');
    else await assert.rejects(async () => x.store.quarantinePublicInvocationOutput(x.id, input));
    assert.equal((await x.store.readPublicInvocationOutputRecovery(x.id)).kind, 'pending');
  });
}
test('pending recovery snapshots and quarantine results do not alias storage', async () => {
  const x = setup();
  ready(x.store);
  const read = await x.store.readPublicInvocationOutputRecovery(x.id);
  Reflect.set(read.expected, 'content', 'mutated');
  assert.equal((await x.store.readPublicInvocationOutputRecovery(x.id)).expected.content, 'public answer');
  const result = await quarantine(x);
  Reflect.set(result.message.extra.publicOutputRecoveryV1, 'reason', 'identity_mismatch');
  assert.equal(x.store.getById(x.id).extra.publicOutputRecoveryV1.reason, 'missing_terminal_proof');
});
test('idempotent pending replay does not duplicate or reorder discovery', async () => {
  const store = ready(new MessageStore());
  const input = { ...fixture(), idempotencyKey: 'same' };
  store.appendIdempotent(input);
  const before = await page(store);
  assert.equal(store.appendIdempotent(input).idempotent, true);
  assert.deepEqual(await page(store), before);
});
test('discovery uses insertion sequence rather than sortable message id or timestamp', async () => {
  const store = ready(new MessageStore());
  const high = fixture(900),
    low = fixture(2);
  store.append(high);
  store.append(low);
  assert.deepEqual((await page(store)).ids, [high.reservedId, low.reservedId]);
});
test('keyset discovery reaches later rows after page removal and concurrent older-id append', async () => {
  const store = ready(new MessageStore());
  const inputs = [fixture(90), fixture(91), fixture(92)];
  inputs.forEach((x) => store.append(x));
  const first = await page(store, undefined, 1);
  assert.deepEqual(first.ids, [inputs[0].reservedId]);
  assert.equal(first.exhausted, false);
  await store.transitionPublicInvocationOutput(inputs[0].reservedId, { expected: inputs[0], nextState: 'abandoned' });
  const late = fixture(2);
  store.append(late);
  const second = await page(store, first.nextCursor, 1);
  assert.deepEqual(second.ids, [inputs[1].reservedId]);
  const rest = await page(store, second.nextCursor);
  assert.deepEqual(rest.ids, [inputs[2].reservedId, late.reservedId]);
});
test('durable checkpoint crosses deferred prefix and uses revision CAS before wrap', async () => {
  const store = ready(new MessageStore());
  [fixture(2), fixture(3)].forEach((x) => store.append(x));
  const initial = await store.getPublicInvocationOutputRecoveryCheckpoint();
  const first = await page(store, undefined, 1);
  const update = await store.advancePublicInvocationOutputRecoveryCheckpoint({
    expectedRevision: initial.revision,
    cursor: first.nextCursor,
  });
  assert.equal(update.kind, 'updated');
  assert.equal(
    (
      await store.advancePublicInvocationOutputRecoveryCheckpoint({
        expectedRevision: initial.revision,
        cursor: first.nextCursor,
      })
    ).kind,
    'conflict',
  );
  const checkpoint = await store.getPublicInvocationOutputRecoveryCheckpoint();
  assert.deepEqual((await page(store, checkpoint.cursor)).ids, [fixture(3).reservedId]);
  assert.equal(
    (
      await store.advancePublicInvocationOutputRecoveryCheckpoint({
        expectedRevision: checkpoint.revision,
        cursor: null,
      })
    ).kind,
    'updated',
  );
  assert.equal((await store.getPublicInvocationOutputRecoveryCheckpoint()).cursor, null);
});
for (const limit of [0, -1, 1.5, 1001]) {
  test(`discovery rejects unbounded or invalid page limit ${limit}`, async () => {
    const store = ready(new MessageStore());
    await assert.rejects(async () => page(store, undefined, limit));
  });
}
test('soft delete quarantines and restore never reenables terminal promotion', async () => {
  const x = setup();
  ready(x.store);
  x.store.softDelete(x.id, 'owner');
  assert.deepEqual((await page(x.store)).ids, []);
  assert.equal(x.store.getById(x.id).extra.publicOutputRecoveryV1.reason, 'output_deleted');
  x.store.restore(x.id);
  assert.equal((await x.store.readPublicInvocationOutputRecovery(x.id)).kind, 'quarantined');
  assert.equal(
    (await x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState: 'committed' })).kind,
    'conflict',
  );
});
for (const deletion of ['hardDelete', 'deleteByThread']) {
  test(`${deletion} removes pending membership and cannot recreate recovery evidence`, async () => {
    const x = setup();
    ready(x.store);
    x.store[deletion](deletion === 'hardDelete' ? x.id : scope.threadId, 'owner');
    assert.deepEqual((await page(x.store)).ids, []);
    const read = await x.store.readPublicInvocationOutputRecovery(x.id);
    assert.ok(['missing', 'malformed'].includes(read.kind));
    assert.notEqual(
      (await x.store.transitionPublicInvocationOutput(x.id, { expected: x.expected, nextState: 'committed' })).kind,
      'updated',
    );
  });
}
for (const mutation of [
  'content',
  'optional malformed',
  'required empty',
  'unknown field',
  'missing companion',
  'digest',
]) {
  test(`Redis recovery raw reader rejects ${mutation} before forgiving hydration`, async () => {
    const x = setup();
    const store = rawStore({});
    api(store, 'readPublicInvocationOutputRecovery');
    ready(x.store);
    const raw = rawFixture(x.store.getById(x.id));
    if (mutation === 'content') raw.content = 'changed';
    if (mutation === 'optional malformed') raw.metadata = '{';
    if (mutation === 'required empty') raw.mentions = '';
    if (mutation === 'unknown field') raw.unrecognizedRecoveryOverride = 'true';
    if (mutation === 'missing companion') {
      const extra = JSON.parse(raw.extra);
      delete extra.publicOutputRecoveryV1;
      raw.extra = JSON.stringify(extra);
    }
    if (mutation === 'digest') {
      const extra = JSON.parse(raw.extra);
      extra.publicOutputRecoveryV1.appendDigest = '0'.repeat(64);
      raw.extra = JSON.stringify(extra);
    }
    assert.equal((await rawStore(raw).readPublicInvocationOutputRecovery(x.id)).kind, 'malformed');
  });
}
test('Redis recovery reader accepts canonical optional empty strings and reconstructs exact pending snapshot', async () => {
  const x = setup();
  api(rawStore({}), 'readPublicInvocationOutputRecovery');
  ready(x.store);
  const read = await rawStore(rawFixture(x.store.getById(x.id))).readPublicInvocationOutputRecovery(x.id);
  assert.equal(read.kind, 'pending');
  assert.deepEqual(read.expected, x.expected);
});
test('Redis recovery reader reports dangling index target as missing without writes', async () => {
  const store = rawStore({});
  api(store, 'readPublicInvocationOutputRecovery');
  assert.equal((await store.readPublicInvocationOutputRecovery(fixture().reservedId)).kind, 'missing');
});

/** Shared transport double: real append serializer, separate store instances, atomic raw receipt contracts.
 * This exercises JS integration, not Redis/Lua execution. No network client is created.
 */
function redisBackend() {
  const hashes = new Map(),
    strings = new Map(),
    index = new Map();
  let sequence = 0,
    throwAfterApply = false,
    beforeCas;
  const flat = (hash) => Object.entries(hash).flat();
  const client = {
    options: {},
    get: async (key) => strings.get(key) ?? null,
    hgetall: async (key) => structuredClone(hashes.get(key) ?? {}),
    hdel: async (key, ...fields) => {
      const hash = hashes.get(key);
      fields.forEach((f) => {
        if (hash) delete hash[f];
      });
    },
    zrange: async () => [...hashes.values()].map((h) => h.id),
    zrangebyscore: async (_key, after, _max, _scores, _limit, _zero, count) =>
      [...index]
        .filter(([, seq]) => seq > Number(after.slice(1)))
        .sort((a, b) => a[1] - b[1])
        .slice(0, count)
        .flatMap(([id, seq]) => [id, String(seq)]),
    multi() {
      const commands = [];
      const tx = {
        del(key) {
          commands.push(() => {
            hashes.delete(key);
            strings.delete(key);
          });
          return tx;
        },
        zrem(_key, id) {
          commands.push(() => index.delete(id));
          return tx;
        },
        async exec() {
          commands.forEach((f) => f());
          return commands.map(() => [null, 1]);
        },
      };
      return tx;
    },
    async eval(script, keyCount, ...values) {
      const keys = values.slice(0, keyCount),
        args = values.slice(keyCount);
      if (script === APPEND_WITH_VISIBILITY_LUA) {
        assert.equal(keyCount, 1);
        const idem = args[7];
        if (idem && strings.has(idem)) return strings.get(idem);
        assert.equal(hashes.has(keys[0]), false, 'reserved output collision');
        const at = 9 + Number(args[8]);
        const pairs = args.slice(at + 1);
        assert.equal(pairs.length, Number(args[at]) * 2);
        const hash = Object.fromEntries(
          Array.from({ length: pairs.length / 2 }, (_, i) => [String(pairs[2 * i]), String(pairs[2 * i + 1])]),
        );
        assert.equal(args[6], '0', 'public recovery has no TTL');
        assert.equal(JSON.parse(hash.extra).publicOutputRecoveryV1.state, 'pending');
        hash.visibilitySeq = String(100 + sequence);
        hashes.set(keys[0], hash);
        index.set(hash.id, ++sequence);
        if (idem) strings.set(idem, hash.id);
        return Number(hash.visibilitySeq);
      }
      if (script === PUBLIC_OUTPUT_THREAD_DELETE_LUA) {
        assert.equal(keyCount, 5);
        const threadId = keys[0].slice('msg:thread:'.length);
        const ids = [...hashes.values()].filter((h) => h.threadId === threadId).map((h) => h.id);
        for (const id of ids) {
          hashes.delete(`msg:${id}`);
          index.delete(id);
        }
        return ids.length;
      }
      if (script === PUBLIC_OUTPUT_RETIRE_MISSING_LUA) {
        if (hashes.has(keys[0])) return 0;
        return index.delete(args[0]) ? 1 : 0;
      }
      if (script === PUBLIC_OUTPUT_CHECKPOINT_LUA) {
        assert.equal(keyCount, 1);
        if ((strings.get(keys[0]) ?? '') !== args[0]) return 0;
        strings.set(keys[0], args[1]);
        return 1;
      }
      assert.ok([TRANSITION_PUBLIC_OUTPUT_LUA, PUBLIC_OUTPUT_DELETE_LUA].includes(script));
      assert.equal(keyCount, 2);
      if (beforeCas) {
        const action = beforeCas;
        beforeCas = undefined;
        action(hashes.get(keys[0]));
      }
      const hash = hashes.get(keys[0]);
      if (!hash) return [-1];
      if (!isDeepStrictEqual(Object.fromEntries(JSON.parse(args[0])), hash)) return [0];
      let code = 2;
      if (script === PUBLIC_OUTPUT_DELETE_LUA) {
        if (args[2] === 'hard')
          Object.assign(hash, {
            content: '',
            contentBlocks: '',
            toolEvents: '',
            metadata: '',
            extra: '',
            pluginMessage: '',
            custodyOfferV1: '',
            thinking: '',
            mentions: '[]',
            _tombstone: '1',
          });
        else if (args[5]) hash.extra = args[5];
        hash.deletedAt = args[3];
        hash.deletedBy = args[4];
        index.delete(args[1]);
        code = 1;
      } else if (args[1]) {
        hash.extra = args[1];
        index.delete(args[2]);
        code = 1;
      }
      if (throwAfterApply) {
        throwAfterApply = false;
        throw new Error('unknown applied transport failure');
      }
      return [code, ...flat(hash)];
    },
  };
  return {
    hashes,
    strings,
    index,
    newStore() {
      const store = new RedisMessageStore(client);
      store.ensureVisibilityMigrated = async () => {};
      return store;
    },
    failAfterApply() {
      throwAfterApply = true;
    },
    race(fn) {
      beforeCas = fn;
    },
  };
}

for (const disposition of ['committed', 'abandoned', 'quarantined']) {
  test(`real serializer recovery to ${disposition} atomically retires discovery and replays across Redis instances`, async () => {
    const backend = redisBackend(),
      a = backend.newStore(),
      b = backend.newStore(),
      input = fixture();
    await a.append(input);
    const read = await b.readPublicInvocationOutputRecovery(input.reservedId);
    assert.equal(read.kind, 'pending');
    assert.deepEqual(read.expected, input);
    const finish = () =>
      disposition === 'quarantined'
        ? b.quarantinePublicInvocationOutput(input.reservedId, {
            expected: read.expected,
            reason: 'missing_terminal_proof',
          })
        : b.transitionPublicInvocationOutput(input.reservedId, { expected: read.expected, nextState: disposition });
    assert.equal((await finish()).kind, 'updated');
    assert.deepEqual((await page(a)).ids, []);
    assert.equal((await finish()).kind, 'existing');
    const recovery = await a.readPublicInvocationOutputRecovery(input.reservedId);
    assert.equal(recovery.kind, disposition === 'quarantined' ? 'quarantined' : 'terminal');
    assert.equal(Boolean(committedPublicInvocationOutput(recovery.message)), disposition === 'committed');
  });
}
for (const first of ['terminal', 'quarantine']) {
  test(`Redis raw CAS has one winner when concurrent ${first} starts first`, async () => {
    const backend = redisBackend(),
      a = backend.newStore(),
      b = backend.newStore(),
      input = fixture();
    await a.append(input);
    const terminal = () =>
      a.transitionPublicInvocationOutput(input.reservedId, { expected: input, nextState: 'committed' });
    const quarantine = () =>
      b.quarantinePublicInvocationOutput(input.reservedId, { expected: input, reason: 'missing_terminal_proof' });
    const result = await Promise.all(
      (first === 'terminal' ? [terminal, quarantine] : [quarantine, terminal]).map((f) => f()),
    );
    assert.deepEqual(
      result.map((r) => r.kind),
      ['updated', 'conflict'],
    );
    assert.deepEqual((await page(a)).ids, []);
  });
}
for (const next of ['committed', 'quarantined']) {
  test(`Redis ${next} throw-after-apply is recoverable only through exact same snapshot`, async () => {
    const backend = redisBackend(),
      store = backend.newStore(),
      expected = fixture();
    await store.append(expected);
    const finish = () =>
      next === 'committed'
        ? store.transitionPublicInvocationOutput(expected.reservedId, { expected, nextState: next })
        : store.quarantinePublicInvocationOutput(expected.reservedId, { expected, reason: 'missing_terminal_proof' });
    backend.failAfterApply();
    await assert.rejects(finish, /unknown applied/);
    assert.equal((await finish()).kind, 'existing');
    const changed = structuredClone(expected);
    changed.content = 'different';
    assert.equal(
      (
        await store.quarantinePublicInvocationOutput(expected.reservedId, {
          expected: changed,
          reason: 'missing_terminal_proof',
        })
      ).kind,
      'conflict',
    );
  });
}
test('Redis durable checkpoint crosses deferred first page across instances and concurrent checkpoint owners', async () => {
  const backend = redisBackend(),
    a = backend.newStore(),
    b = backend.newStore();
  for (const n of [90, 91, 92]) await a.append(fixture(n));
  const first = await page(a, undefined, 1);
  const results = await Promise.all(
    [a, b].map((store) =>
      store.advancePublicInvocationOutputRecoveryCheckpoint({ expectedRevision: 0, cursor: first.nextCursor }),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.kind),
    ['updated', 'conflict'],
  );
  const cp = await backend.newStore().getPublicInvocationOutputRecoveryCheckpoint();
  const second = await page(b, cp.cursor, 1);
  assert.deepEqual(second.ids, [fixture(91).reservedId]);
  await b.transitionPublicInvocationOutput(fixture(91).reservedId, { expected: fixture(91), nextState: 'abandoned' });
  await a.append(fixture(2));
  const rest = await page(a, second.nextCursor);
  assert.deepEqual(rest.ids, [fixture(92).reservedId, fixture(2).reservedId]);
  assert.equal(rest.exhausted, true);
  await b.advancePublicInvocationOutputRecoveryCheckpoint({ expectedRevision: cp.revision, cursor: null });
  assert.equal((await a.getPublicInvocationOutputRecoveryCheckpoint()).cursor, null);
});
test('Redis append idempotency loser never consumes another recovery sequence', async () => {
  const backend = redisBackend(),
    a = backend.newStore(),
    b = backend.newStore(),
    input = { ...fixture(), idempotencyKey: 'same' };
  const result = await Promise.all([a.appendIdempotent(input), b.appendIdempotent(input)]);
  assert.equal(result.filter((r) => r.idempotent).length, 1);
  await a.append(fixture(3));
  const all = await page(b);
  assert.equal(all.nextCursor, 'public-output:2');
  assert.equal(all.ids.length, 2);
});
for (const deletion of ['softDelete', 'hardDelete', 'deleteByThread']) {
  test(`Redis ${deletion} retires membership with deletion and preserves no-replay on restore`, async () => {
    const backend = redisBackend(),
      store = backend.newStore(),
      input = fixture();
    input.extra.futureArray = [];
    await store.append(input);
    await store[deletion](deletion === 'deleteByThread' ? scope.threadId : input.reservedId, 'owner');
    assert.deepEqual((await page(store)).ids, []);
    if (deletion === 'softDelete') {
      assert.deepEqual((await store.getById(input.reservedId)).extra.publicOutputRecoveryV1.reason, 'output_deleted');
      assert.deepEqual(JSON.parse(backend.hashes.get(`msg:${input.reservedId}`).extra).futureArray, []);
      await store.restore(input.reservedId);
      assert.equal((await store.readPublicInvocationOutputRecovery(input.reservedId)).kind, 'quarantined');
      assert.equal(
        (await store.transitionPublicInvocationOutput(input.reservedId, { expected: input, nextState: 'committed' }))
          .kind,
        'conflict',
      );
    }
  });
}
test('Redis deletion raw fence prevents acting on replaced output', async () => {
  const backend = redisBackend(),
    store = backend.newStore(),
    input = fixture();
  await store.append(input);
  backend.race((hash) => {
    hash.content = 'replacement';
  });
  await assert.rejects(() => store.softDelete(input.reservedId, 'owner'), /changed during deletion/);
  assert.deepEqual((await page(store)).ids, [input.reservedId]);
  assert.equal(backend.hashes.get(`msg:${input.reservedId}`).deletedAt, undefined);
});
for (const field of ['thinking', 'metadata', 'mentionsUser', 'extra']) {
  test(`strict recovery roundtrip preserves optional ${field} canonical shape`, async () => {
    const backend = redisBackend(),
      store = backend.newStore(),
      input = fixture();
    if (field === 'thinking') input.thinking = '';
    if (field === 'metadata') input.metadata = { empty: [], nested: {} };
    if (field === 'mentionsUser') input.mentionsUser = false;
    if (field === 'extra') {
      input.extra.future = [];
      input.extra.tracing = { traceId: 'trace', spanId: 'span' };
    }
    await store.append(input);
    const result = await store.readPublicInvocationOutputRecovery(input.reservedId);
    assert.equal(result.kind, 'pending');
    assert.deepEqual(result.expected, input);
  });
}
for (const mutation of [
  'missing companion',
  'null companion',
  'terminal companion',
  'unknown raw field',
  'changed body',
  'bad digest',
]) {
  test(`terminal CAS refuses recovery corruption: ${mutation}`, async () => {
    const backend = redisBackend(),
      store = backend.newStore(),
      expected = fixture();
    await store.append(expected);
    const hash = backend.hashes.get(`msg:${expected.reservedId}`),
      extra = JSON.parse(hash.extra);
    if (mutation === 'missing companion') delete extra.publicOutputRecoveryV1;
    if (mutation === 'null companion') extra.publicOutputRecoveryV1 = null;
    if (mutation === 'terminal companion') {
      extra.publicOutputV1.state = 'committed';
      extra.deliveryBoundary = extra.publicOutputV1.boundary;
    }
    if (mutation === 'unknown raw field') hash.foreign = 'true';
    if (mutation === 'changed body') hash.content = 'tampered';
    if (mutation === 'bad digest') extra.publicOutputRecoveryV1.appendDigest = '0'.repeat(64);
    hash.extra = JSON.stringify(extra);
    assert.equal(
      (await store.transitionPublicInvocationOutput(expected.reservedId, { expected, nextState: 'committed' })).kind,
      'conflict',
    );
    assert.equal((await store.readPublicInvocationOutputRecovery(expected.reservedId)).kind, 'malformed');
    assert.deepEqual((await page(store)).ids, [expected.reservedId]);
  });
}

test('Redis pending replay preserves false flags, empty thinking and unknown JSON siblings through strict raw lookup', async () => {
  const backend = redisBackend(),
    store = backend.newStore(),
    input = { ...fixture(), idempotencyKey: 'canonical', mentionsUser: false, thinking: '' };
  input.extra.future = [];
  const first = await store.appendIdempotent(input),
    second = await store.appendIdempotent(input);
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.message, first.message);
});
test('pending projection rejects unknown append fields instead of silently dropping commitments', () => {
  const store = ready(new MessageStore());
  assert.throws(() => store.append({ ...fixture(), foreignIdentity: 'x' }), /public.*output/i);
  assert.equal(store.size, 0);
});
for (const storeKind of ['memory', 'redis']) {
  test(`${storeKind} recovery commitment mismatch cannot be promoted through matching caller body`, async () => {
    const input = fixture();
    const backend = redisBackend(),
      store = storeKind === 'redis' ? backend.newStore() : new MessageStore();
    await store.append(input);
    if (storeKind === 'redis') backend.hashes.get(`msg:${input.reservedId}`).content = 'altered';
    else store.messages.find((m) => m.id === input.reservedId).content = 'altered';
    const altered = { ...input, content: 'altered' };
    assert.equal(
      (await store.transitionPublicInvocationOutput(input.reservedId, { expected: altered, nextState: 'committed' }))
        .kind,
      'conflict',
    );
    assert.equal(
      (
        await store.quarantinePublicInvocationOutput(input.reservedId, {
          expected: altered,
          reason: 'identity_mismatch',
        })
      ).kind,
      'conflict',
    );
  });
}
test('Redis checkpoint corruption fails closed without resetting durable cursor', async () => {
  const backend = redisBackend(),
    store = backend.newStore();
  const key = 'msg:public-output:checkpoint',
    bad = JSON.stringify({ revision: 1 });
  backend.strings.set(key, bad);
  await assert.rejects(() => store.getPublicInvocationOutputRecoveryCheckpoint());
  await assert.rejects(() =>
    store.advancePublicInvocationOutputRecoveryCheckpoint({ expectedRevision: 1, cursor: null }),
  );
  assert.equal(backend.strings.get(key), bad);
});

for (const backendKind of ['memory', 'redis']) {
  test(`${backendKind} dangling-index cleanup rechecks absence and never retires a live row`, async () => {
    const backend = redisBackend(),
      store = backendKind === 'memory' ? new MessageStore() : backend.newStore(),
      input = fixture();
    await store.append(input);
    assert.equal(await store.retireMissingPublicInvocationOutput(input.reservedId), false);
    if (backendKind === 'memory') store.messages = [];
    else backend.hashes.delete(`msg:${input.reservedId}`);
    assert.equal((await store.readPublicInvocationOutputRecovery(input.reservedId)).kind, 'missing');
    assert.equal(await store.retireMissingPublicInvocationOutput(input.reservedId), true);
    assert.equal(await store.retireMissingPublicInvocationOutput(input.reservedId), false);
    assert.deepEqual((await page(store)).ids, []);
  });
}
for (const mode of ['softDelete', 'hardDelete']) {
  test(`Redis ordinary ${mode} keeps deletion behavior without inventing recovery metadata`, async () => {
    const backend = redisBackend(),
      store = backend.newStore(),
      id = fixture().reservedId;
    backend.hashes.set(`msg:${id}`, {
      id,
      threadId: scope.threadId,
      userId: scope.userId,
      catId: 'astra',
      content: 'ordinary',
      mentions: '[]',
      timestamp: '2',
      extra: '{"note":[]}',
    });
    const result = await store[mode](id, 'owner');
    assert.equal(result.deletedBy, 'owner');
    assert.equal(JSON.parse(backend.hashes.get(`msg:${id}`).extra || '{}').publicOutputRecoveryV1, undefined);
    if (mode === 'softDelete') assert.equal(result.content, 'ordinary');
    else assert.equal(result.content, '');
  });
}

for (const companion of [null, { v: 1, state: 'pending' }]) {
  test('orphaned malformed recovery companion preserves public presence through ordinary hydration', () => {
    const extra = safeParseExtra(JSON.stringify({ publicOutputRecoveryV1: companion }));
    assert.equal(Object.hasOwn(extra, 'publicOutputRecoveryV1'), true);
    assert.equal(hasPublicInvocationOutput(extra), true);
    assert.equal(extra.publicOutputRecoveryV1, null);
  });
}
