import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveQueueSourceResponseEvidenceFromMessages } from '../src/domains/cats/services/agents/invocation/queue-source-response-evidence.ts';
import {
  legacyBatonHasSucceededReply,
  recoverableDeliveryBoundary,
} from '../src/domains/cats/services/agents/routing/delivery-boundary-recovery.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { MessageStore, mergeMessageExtra } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { parsePublicInvocationOutput } from '../src/domains/cats/services/stores/public-invocation-output.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import { safeParseExtra, serializeExtra } from '../src/domains/cats/services/stores/redis/redis-message-parsers.ts';

const target = { userId: 'owner', threadId: 'public-thread', catId: 'astra' };
const sourceId = '0000000000000001-000001-11111111';
const outputId = '0000000000000002-000001-22222222';

function fixture() {
  const source = { ...target, id: sourceId, catId: null, content: 'public source', timestamp: 1, visibilitySeq: 1 };
  const boundary = {
    v: 1,
    cursor: cursorFor(source),
    ...target,
    turnInvocationId: 'child',
    sourceMessageId: sourceId,
  };
  const output = {
    ...target,
    id: outputId,
    content: 'public answer',
    timestamp: 2,
    visibilitySeq: 2,
    origin: 'stream',
    replyTo: sourceId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'child' },
      causal: { kind: 'invocation_reply', triggerMessageId: sourceId },
      deliveryBoundary: boundary,
    },
  };
  const marker = {
    v: 1,
    state: 'committed',
    sourceMessageId: sourceId,
    childInvocationId: 'child',
    outputMessageId: outputId,
    boundary: structuredClone(boundary),
  };
  return { source, output, marker };
}

function evidence(output, invocationId = 'child') {
  return resolveQueueSourceResponseEvidenceFromMessages({
    messages: [output],
    catId: target.catId,
    invocationId,
    sourceMessageIds: [sourceId],
  });
}

function recover(source, output) {
  return recoverableDeliveryBoundary([source, output], target);
}

async function legacy(source, output) {
  const withoutBoundary = structuredClone(output);
  delete withoutBoundary.extra.deliveryBoundary;
  return legacyBatonHasSucceededReply({
    messages: [source, withoutBoundary],
    sourceMessageId: sourceId,
    explicitSourceMessageId: undefined,
    target,
    turnExecutionStore: {
      get: async () => ({
        ...target,
        invocationId: 'child',
        parentInvocationId: 'parent',
        causal: { triggerMessageId: sourceId },
        status: 'succeeded',
      }),
    },
  });
}

test('ordinary output fixture remains recoverable and source-bound without a public marker', async () => {
  const { source, output } = fixture();
  assert.equal(evidence(output).length, 1);
  assert.deepEqual([...recover(source, output).answeredSourceIds], [sourceId]);
  assert.equal(await legacy(source, output), true);
});

test('committed public fixture has an exact output, child, source and installed boundary', () => {
  const { source, output, marker } = fixture();
  output.extra.publicOutputV1 = marker;
  assert.equal(evidence(output).length, 1);
  assert.deepEqual([...recover(source, output).answeredSourceIds], [sourceId]);
});

for (const [name, value] of [
  ['pending_terminal', { state: 'pending_terminal' }],
  ['abandoned', { state: 'abandoned' }],
  ['malformed', {}],
  ['null', null],
  ['present undefined', undefined],
]) {
  test(`public ${name} output cannot answer a source through Queue or either recovery path`, async () => {
    const { source, output, marker } = fixture();
    output.extra.publicOutputV1 = value?.state ? { ...marker, ...value } : value;
    assert.deepEqual(evidence(output), [], 'uncommitted public output must not consume Queue source');
    assert.equal(recover(source, output).cursor, undefined);
    assert.equal(recover(source, output).answeredSourceIds.size, 0);
    assert.equal(await legacy(source, output), false);
  });
}

for (const [name, change] of [
  [
    'foreign source',
    (m) => {
      m.sourceMessageId = 'foreign';
    },
  ],
  [
    'foreign child',
    (m) => {
      m.childInvocationId = 'foreign';
    },
  ],
  [
    'foreign output',
    (m) => {
      m.outputMessageId = 'foreign';
    },
  ],
  [
    'foreign boundary owner',
    (m) => {
      m.boundary.userId = 'foreign';
    },
  ],
  [
    'different boundary cursor',
    (m) => {
      m.boundary.cursor = `v2:0000000000000000:${sourceId}`;
    },
  ],
  [
    'additional marker field',
    (m) => {
      m.authorized = true;
    },
  ],
  [
    'additional boundary field',
    (m) => {
      m.boundary.authorized = true;
    },
  ],
]) {
  test(`committed public output rejects ${name}`, () => {
    const { source, output, marker } = fixture();
    change(marker);
    output.extra.publicOutputV1 = marker;
    assert.deepEqual(evidence(output), [], 'public output requires exact committed identity');
    assert.equal(recover(source, output).cursor, undefined);
  });
}

for (const state of ['pending_terminal', 'committed', 'abandoned']) {
  test(`Redis extra round-trip preserves public ${state} identity`, () => {
    const { output, marker } = fixture();
    marker.state = state;
    output.extra.publicOutputV1 = marker;
    const parsed = safeParseExtra(serializeExtra(output.extra));
    assert.deepEqual(parsed?.publicOutputV1, marker, 'Redis must preserve public output marker');
  });
}

for (const value of [null, {}, { v: 1, state: 'unknown' }]) {
  test(`Redis malformed public marker stays fail-closed: ${JSON.stringify(value)}`, () => {
    const { source, output } = fixture();
    output.extra = safeParseExtra(JSON.stringify({ ...output.extra, publicOutputV1: value }));
    assert.equal(Object.hasOwn(output.extra, 'publicOutputV1'), true, 'malformed marker must not become absent');
    assert.deepEqual(evidence(output), []);
    assert.equal(recover(source, output).cursor, undefined);
  });
}

test('generic extra merge cannot add or upgrade a public output marker', () => {
  const { marker } = fixture();
  const pending = { ...marker, state: 'pending_terminal' };
  assert.equal(mergeMessageExtra({}, { publicOutputV1: marker })?.publicOutputV1, undefined);
  assert.deepEqual(mergeMessageExtra({ publicOutputV1: pending }, { publicOutputV1: marker }).publicOutputV1, pending);
});

for (const method of ['updateExtra', 'augmentStreamMetadata']) {
  test(`memory ${method} cannot upgrade a pending public output`, () => {
    const { output, marker } = fixture();
    const pending = { ...marker, state: 'pending_terminal' };
    const store = new MessageStore();
    const { id: _id, visibilitySeq: _visibilitySeq, ...input } = output;
    delete input.extra.deliveryBoundary;
    const stored = store.append({
      ...input,
      reservedId: outputId,
      extra: { ...output.extra, publicOutputV1: pending },
    });
    const patch = { publicOutputV1: marker };
    store[method](stored.id, method === 'updateExtra' ? patch : { extra: patch });
    assert.deepEqual(
      store.getById(stored.id).extra.publicOutputV1,
      pending,
      'generic patch cannot commit public output',
    );
  });
}

test('public output cannot use parent identity as an exact child witness', () => {
  const { output, marker } = fixture();
  output.extra.publicOutputV1 = marker;
  assert.deepEqual(evidence(output, 'parent'), []);
});

test('public output never uses legacy success recovery when its boundary is absent', async () => {
  const { source, output, marker } = fixture();
  output.extra.publicOutputV1 = marker;
  assert.equal(await legacy(source, output), false);
  delete output.extra.deliveryBoundary;
  assert.deepEqual(evidence(output), []);
  assert.equal(recover(source, output).cursor, undefined);
});

test('pending public output is rejected directly by both recovery paths even with a succeeded child', async () => {
  const { source, output, marker } = fixture();
  output.extra.publicOutputV1 = { ...marker, state: 'pending_terminal' };
  assert.equal(recover(source, output).cursor, undefined);
  assert.equal(await legacy(source, output), false);
});

test('public output codec snapshots and freezes its receipt without evaluating accessors', () => {
  const { marker } = fixture();
  const parsed = parsePublicInvocationOutput(marker);
  marker.boundary.userId = 'changed';
  assert.equal(parsed.boundary.userId, 'owner');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.boundary));
  let reads = 0;
  Object.defineProperty(marker, 'state', {
    get() {
      reads++;
      return 'committed';
    },
  });
  assert.equal(parsePublicInvocationOutput(marker), undefined);
  assert.equal(reads, 0);
});

test('Redis serialization preserves present undefined public identity as an invalid marker', () => {
  const { output } = fixture();
  output.extra.publicOutputV1 = undefined;
  const parsed = safeParseExtra(serializeExtra(output.extra));
  assert.equal(Object.hasOwn(parsed, 'publicOutputV1'), true);
  output.extra = parsed;
  assert.deepEqual(evidence(output), []);
});

for (const method of ['updateExtra', 'augmentStreamMetadata']) {
  test(`Redis ${method} refuses a public snapshot before any write`, async () => {
    const { output, marker } = fixture();
    output.extra.publicOutputV1 = { ...marker, state: 'pending_terminal' };
    let writes = 0;
    const store = new RedisMessageStore({
      options: {},
      eval: async () => {
        writes++;
        throw new Error('unexpected Redis mutation');
      },
      multi: () => {
        writes++;
        throw new Error('unexpected Redis transaction');
      },
    });
    store.getById = async () => structuredClone(output);
    const patch = { publicOutputV1: marker };
    assert.equal(await store[method](outputId, method === 'updateExtra' ? patch : { extra: patch }), null);
    assert.equal(writes, 0);
  });
}
