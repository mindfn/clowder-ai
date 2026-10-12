import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { committedPublicInvocationOutput } from '../src/domains/cats/services/stores/public-invocation-output.ts';
import { TRANSITION_PUBLIC_OUTPUT_LUA } from '../src/domains/cats/services/stores/redis/public-output-terminal-lua.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { APPEND_WITH_VISIBILITY_LUA } from '../src/domains/cats/services/stores/redis/redis-visibility-lua-scripts.ts';

const sourceId = '0000000000000001-000001-11111111';
const outputId = '0000000000000002-000001-22222222';
const scope = { userId: 'owner', threadId: 'public-thread', catId: 'astra' };
function fixture() {
  const boundary = {
    v: 1,
    ...scope,
    sourceMessageId: sourceId,
    turnInvocationId: 'child',
    cursor: cursorFor({ ...scope, catId: null, id: sourceId, timestamp: 1, visibilitySeq: 1 }),
  };
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

/** Captures the real append serializer's Lua argv, without recreating its optional-field defaults.
 * The eval double models only these two contracts; it is not proof of real Redis Lua behavior.
 */
async function setup() {
  let hash;
  let terminalCalls = 0;
  const redis = {
    options: {},
    hgetall: async () => structuredClone(hash ?? {}),
    eval: async (script, keyCount, _key, ...argv) => {
      if (script === APPEND_WITH_VISIBILITY_LUA) {
        assert.equal(keyCount, 1);
        const countAt = 9 + Number(argv[8]);
        const pairCount = Number(argv[countAt]);
        const pairs = argv.slice(countAt + 1);
        assert.equal(pairs.length, pairCount * 2);
        hash = Object.fromEntries(
          Array.from({ length: pairCount }, (_, i) => [String(pairs[i * 2]), String(pairs[i * 2 + 1])]),
        );
        hash.visibilitySeq = '7';
        return 7;
      }
      assert.equal(script, TRANSITION_PUBLIC_OUTPUT_LUA);
      assert.equal(keyCount, 2);
      argv.shift(); // pending index is the second key
      terminalCalls++;
      assert.deepEqual(Object.fromEntries(JSON.parse(argv[0])), hash);
      if (argv[1] !== '') hash.extra = argv[1];
      return [argv[1] === '' ? 2 : 1, ...Object.entries(hash).flat()];
    },
  };
  const store = new RedisMessageStore(redis);
  store.ensureVisibilityMigrated = async () => {};
  const expected = fixture();
  const appended = await store.appendIdempotent(expected);
  assert.equal(appended.idempotent, false);
  assert.equal(appended.message.id, outputId);
  return {
    store,
    expected,
    raw: () => structuredClone(hash),
    terminalCalls: () => terminalCalls,
    seedTerminal(state) {
      const extra = JSON.parse(hash.extra);
      extra.publicOutputV1.state = state;
      delete extra.publicOutputRecoveryV1;
      if (state === 'committed') extra.deliveryBoundary = extra.publicOutputV1.boundary;
      hash.extra = JSON.stringify(extra);
    },
  };
}

test('real Redis append serializer fixture persists three empty optional JSON fields', async () => {
  const x = await setup();
  const raw = x.raw();
  for (const key of ['contentBlocks', 'toolEvents', 'metadata']) {
    assert.equal(Object.hasOwn(raw, key), true);
    assert.equal(raw[key], '');
    assert.equal((await x.store.getById(outputId))[key], undefined);
  }
  assert.equal(x.terminalCalls(), 0);
});
for (const state of ['committed', 'abandoned']) {
  test(`serializer-driven pending output reaches ${state} and idempotent replay`, async () => {
    const x = await setup();
    const result = await x.store.transitionPublicInvocationOutput(outputId, { expected: x.expected, nextState: state });
    assert.equal(result.kind, 'updated', 'canonical empty optional JSON fields must permit terminal transition');
    assert.equal(result.message.extra.publicOutputV1.state, state);
    assert.equal(Boolean(committedPublicInvocationOutput(result.message)), state === 'committed');
    const replay = await x.store.transitionPublicInvocationOutput(outputId, { expected: x.expected, nextState: state });
    assert.equal(replay.kind, 'existing');
    assert.equal(x.terminalCalls(), 2);
    for (const key of ['contentBlocks', 'toolEvents', 'metadata']) assert.equal(x.raw()[key], '');
  });
  test(`serializer-driven ${state} receipt permits canonical no-op replay`, async () => {
    const x = await setup();
    x.seedTerminal(state);
    const before = x.raw();
    const replay = await x.store.transitionPublicInvocationOutput(outputId, { expected: x.expected, nextState: state });
    assert.equal(replay.kind, 'existing', 'canonical empty optional JSON fields must permit terminal replay');
    assert.deepEqual(x.raw(), before);
    assert.equal(x.terminalCalls(), 1);
  });
}
