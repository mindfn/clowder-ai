import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { TerminalProofRecoveryBarrier } from '../src/domains/cats/services/agents/invocation/TerminalProofRecoveryBarrier.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { assertQueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.ts';
import { publicOutputLookupPrefixes } from '../src/domains/cats/services/stores/public-invocation-output-discovery.ts';
import { LOOKUP_PUBLIC_OUTPUT_LUA } from '../src/domains/cats/services/stores/redis/public-output-discovery-lua.ts';
import {
  PUBLIC_OUTPUT_DELETE_LUA,
  PUBLIC_OUTPUT_THREAD_DELETE_LUA,
} from '../src/domains/cats/services/stores/redis/public-output-recovery-lua.ts';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.ts';
import {
  APPEND_WITH_VISIBILITY_LUA,
  ENSURE_VISIBILITY_MIGRATED_LUA,
} from '../src/domains/cats/services/stores/redis/redis-visibility-lua-scripts.ts';

const url = new URL('../src/domains/cats/services/agents/invocation/PublicQueueOutputClassifier.ts', import.meta.url);
const module = existsSync(url) ? await import(url.href) : {};
const sourceId = '0000000000001000-000001-00000001';
const outputId = '0000000000002000-000001-00000002';
const childId = 'exact-child';
const scope = { userId: 'owner', threadId: 'thread', catId: 'astra' };
const input = { ...scope, sourceMessageId: sourceId };

function fixture(status = 'succeeded', output = 'committed', witness = 'all') {
  const carrier = {
    version: 1,
    admissionId: 'admission',
    sourceMessageId: sourceId,
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'astra',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  };
  const custody = createInitialQueuedMessageCustody({
    id: 'entry',
    ...scope,
    ownerAuthProvenance: 'unknown',
    source: 'connector',
    content: 'input',
    messageId: sourceId,
    mergedMessageIds: [],
    targetCats: ['astra'],
    allTargetCats: ['astra'],
    intent: 'execute',
    autoExecute: true,
    status: 'queued',
    priority: 'normal',
    createdAt: 1000,
    pluginPublicInvocation: carrier,
  });
  const has = (name) => witness === 'all' || witness === name;
  if (has('attempt')) Object.assign(custody.targetAttempts[0], { invocationId: childId, state: 'starting' });
  if (has('awakened')) {
    custody.awakenedInvocationIdByCatId = { astra: childId };
    custody.awakenedAtByCatId = { astra: 1100 };
  }
  if (has('seen')) {
    custody.seenByCatIds = ['astra'];
    custody.seenInvocationIdByCatId = { astra: childId };
  }
  if (has('exposure')) custody.bodyExposures = [{ targetCatId: 'astra', invocationId: childId, seenAt: 1200 }];
  assertQueuedMessageCustody(custody);
  const messages = new MessageStore();
  const source = messages.append({
    reservedId: sourceId,
    threadId: scope.threadId,
    userId: scope.userId,
    catId: null,
    content: 'input',
    mentions: ['astra'],
    timestamp: 1000,
    source: { connector: 'fixture' },
    extra: { pluginMessage: { instanceId: 'instance', revision: 1 } },
  });
  // Publish ingress first, then admit it to Queue without losing its canonical visibility coordinate.
  assert.equal(messages.prepareQueueAdmission(sourceId).kind, 'prepared');
  assert.equal(messages.initializeQueueCustody(sourceId, custody).kind, 'initialized');
  assert.ok(source.visibilitySeq > 0);
  const turns = new InMemoryTurnExecutionStore();
  turns.createRunning({
    invocationId: childId,
    parentInvocationId: 'parent',
    ...scope,
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
    startedAt: 1100,
    causal: { triggerMessageId: sourceId, coveredMessageIds: [sourceId] },
  });
  if (status !== 'running')
    turns.transitionTerminal(childId, {
      status,
      endedAt: 1900,
      ...(status === 'succeeded' ? {} : { terminalReason: 'fixture_failure' }),
    });
  const expected = {
    ...scope,
    reservedId: outputId,
    timestamp: 2000,
    content: 'answer',
    mentions: [],
    origin: 'stream',
    replyTo: sourceId,
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: childId },
      causal: { kind: 'invocation_reply', triggerMessageId: sourceId },
      publicOutputV1: {
        v: 1,
        state: 'pending_terminal',
        sourceMessageId: sourceId,
        childInvocationId: childId,
        outputMessageId: outputId,
        boundary: { v: 1, ...scope, sourceMessageId: sourceId, turnInvocationId: childId, cursor: cursorFor(source) },
      },
    },
  };
  if (output !== 'none') {
    messages.append(expected);
    if (output === 'committed' || output === 'abandoned') {
      assert.equal(
        messages.transitionPublicInvocationOutput(outputId, { expected, nextState: output }).kind,
        'updated',
      );
    } else if (output === 'quarantined') {
      assert.equal(
        messages.quarantinePublicInvocationOutput(outputId, { expected, reason: 'missing_terminal_proof' }).kind,
        'updated',
      );
    } else if (output === 'malformed') {
      messages.messages[1].extra.publicOutputRecoveryV1.appendDigest = '0'.repeat(64);
    }
  }
  const proofBarrier = new TerminalProofRecoveryBarrier();
  proofBarrier.markReady();
  return { messages, turns, proofBarrier, expected };
}
function classifier(f) {
  assert.equal(typeof module.PublicQueueOutputClassifier, 'function', 'missing public queue classifier entry');
  return new module.PublicQueueOutputClassifier({
    messageStore: f.messages,
    turnExecutionStore: f.turns,
    proofBarrier: f.proofBarrier,
  });
}
const classify = (f, selection = input) => classifier(f).classify(selection);
const sourceRow = (f) => f.messages.messages.find((m) => m.id === sourceId);
const outputRow = (f) => f.messages.messages.find((m) => m.id === outputId);

test('classifier control: four durable witness forms survive real memory storage', () => {
  for (const witness of ['seen', 'awakened', 'attempt', 'exposure']) {
    const f = fixture('running', 'pending', witness);
    assertQueuedMessageCustody(f.messages.getById(sourceId).queueCustody);
    assert.equal(f.messages.readPublicInvocationOutputRecovery(outputId).kind, 'pending');
    assert.equal(f.turns.get(childId).status, 'running');
  }
});
test('classifier control: strict store differentiates terminal, pending, quarantine and malformed output', () => {
  for (const [state, kind] of [
    ['committed', 'terminal'],
    ['abandoned', 'terminal'],
    ['pending', 'pending'],
    ['quarantined', 'quarantined'],
    ['malformed', 'malformed'],
  ]) {
    assert.equal(fixture('succeeded', state).messages.readPublicInvocationOutputRecovery(outputId).kind, kind);
  }
});
for (const witness of ['seen', 'awakened', 'attempt', 'exposure']) {
  test(`classifier resolves ${witness}-only child without replaying a pending output`, async () => {
    assert.equal((await classify(fixture('succeeded', 'pending', witness))).kind, 'deferred');
  });
}
for (const [status, output, kind] of [
  ['running', 'none', 'deferred'],
  ['succeeded', 'none', 'conflict'],
  ['failed', 'none', 'conflict'],
  ['running', 'pending', 'deferred'],
  ['succeeded', 'pending', 'deferred'],
  ['succeeded', 'committed', 'committed'],
  ['failed', 'abandoned', 'abandoned'],
  ['canceled', 'abandoned', 'abandoned'],
  ['interrupted', 'abandoned', 'abandoned'],
  ['succeeded', 'abandoned', 'conflict'],
  ['failed', 'committed', 'conflict'],
  ['running', 'committed', 'conflict'],
  ['succeeded', 'quarantined', 'conflict'],
  ['succeeded', 'malformed', 'conflict'],
]) {
  test(`classifier maps ${status} child with ${output} output to ${kind}`, async () => {
    const f = fixture(status, output);
    const before = structuredClone(f.messages.messages);
    const result = await classify(f);
    assert.equal(result.kind, kind);
    assert.deepEqual(f.messages.messages, before, 'classification is read only');
  });
}
for (const [name, mutate] of [
  [
    'foreign owner',
    (r) => {
      r.queueCustody.ownerUserId = 'foreign';
    },
  ],
  [
    'foreign thread',
    (r) => {
      r.threadId = 'foreign';
    },
  ],
  [
    'wrong source',
    (r) => {
      r.queueCustody.pluginPublicInvocation.sourceMessageId = 'foreign';
    },
  ],
  [
    'changed plugin revision',
    (r) => {
      r.extra.pluginMessage.revision = 2;
    },
  ],
  [
    'deleted source',
    (r) => {
      r.deletedAt = 3000;
    },
  ],
  [
    'conflicting witness',
    (r) => {
      r.queueCustody.awakenedInvocationIdByCatId.astra = 'foreign';
    },
  ],
  [
    'withdrawn target',
    (r) => {
      r.queueCustody.withdrawnByCatIds = ['astra'];
      r.queueCustody.withdrawnAtByCatId = { astra: 3000 };
    },
  ],
]) {
  test(`classifier refuses ${name} as current answered custody`, async () => {
    const f = fixture();
    mutate(sourceRow(f));
    assert.equal((await classify(f)).kind, 'conflict');
  });
}
for (const [name, change] of [
  ['owner', { userId: 'foreign' }],
  ['thread', { threadId: 'foreign' }],
  ['cat', { catId: 'codex' }],
  ['id', { invocationId: 'foreign' }],
  ['parent', { parentInvocationId: 'foreign' }],
  ['policy', { queueCompletionPolicy: undefined }],
  ['causal', { causal: { triggerMessageId: sourceId, coveredMessageIds: [sourceId, 'extra'] } }],
]) {
  test(`classifier rejects child ${name} drift`, async () => {
    const f = fixture();
    const child = { ...f.turns.get(childId), ...change };
    f.turns.get = () => child;
    assert.equal((await classify(f)).kind, 'conflict');
  });
}
for (const read of ['source', 'child', 'outputs', 'recovery']) {
  test(`classifier preserves ${read} read outage as deferred`, async () => {
    const f = fixture();
    const fail = () => {
      throw Error('read outage');
    };
    if (read === 'source') f.messages.getById = fail;
    if (read === 'child') f.turns.get = fail;
    if (read === 'outputs') f.messages.findPublicInvocationOutput = fail;
    if (read === 'recovery') f.messages.readPublicInvocationOutputRecovery = fail;
    assert.equal((await classify(f)).kind, 'deferred');
  });
}
test('classifier refuses missing canonical child once proof barrier is ready', async () => {
  const f = fixture();
  f.turns.get = () => null;
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier leaves closed proof barrier deferred', async () => {
  const f = fixture();
  f.proofBarrier = new TerminalProofRecoveryBarrier();
  assert.equal((await classify(f)).kind, 'deferred');
});
test('classifier reports ordinary source as not public without reading child or outputs', async () => {
  const f = fixture();
  delete sourceRow(f).queueCustody.pluginPublicInvocation;
  f.turns.get = () => assert.fail('ordinary path');
  f.messages.findPublicInvocationOutput = () => assert.fail('ordinary path');
  assert.equal((await classify(f)).kind, 'not_public');
});
test('classifier distinguishes unbound public source from authorized replay', async () => {
  assert.equal((await classify(fixture('running', 'none', 'none'))).kind, 'unbound');
});
test('classifier refuses committed output without exact body exposure', async () => {
  assert.equal((await classify(fixture('succeeded', 'committed', 'awakened'))).kind, 'conflict');
});
test('classifier rejects duplicate exact public output instead of combining response witnesses', async () => {
  const f = fixture();
  const second = structuredClone(f.expected);
  second.reservedId = '0000000000002100-000001-00000003';
  second.extra.publicOutputV1.outputMessageId = second.reservedId;
  f.messages.append(second);
  f.messages.transitionPublicInvocationOutput(second.reservedId, { expected: second, nextState: 'committed' });
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier refuses public wrong-child marker associated with the source', async () => {
  const f = fixture();
  outputRow(f).extra.publicOutputV1.childInvocationId = 'foreign';
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier refuses malformed marker presence without legacy response fallback', async () => {
  const f = fixture();
  outputRow(f).extra.publicOutputV1 = null;
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier ignores ordinary output as a public terminal receipt', async () => {
  const f = fixture();
  delete outputRow(f).extra.publicOutputV1;
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier rejects input accessors without invoking them', async () => {
  const f = fixture();
  let reads = 0;
  const selection = { ...input };
  Object.defineProperty(selection, 'sourceMessageId', {
    enumerable: true,
    get() {
      reads++;
      return sourceId;
    },
  });
  assert.equal((await classify(f, selection)).kind, 'conflict');
  assert.equal(reads, 0);
});
test('classifier rejects custody accessors without invoking them', async () => {
  const f = fixture();
  const source = f.messages.getById(sourceId);
  let reads = 0;
  Object.defineProperty(source.queueCustody, 'seenInvocationIdByCatId', {
    enumerable: true,
    get() {
      reads++;
      return { astra: childId };
    },
  });
  f.messages.getById = () => source;
  assert.equal((await classify(f)).kind, 'conflict');
  assert.equal(reads, 0);
});

for (const field of ['catId', 'userId', 'threadId', 'origin', 'replyTo']) {
  test(`classifier rejects strict output ${field} drift`, async () => {
    const f = fixture();
    outputRow(f)[field] = 'foreign';
    assert.equal((await classify(f)).kind, 'conflict');
  });
}
test('classifier rejects installed boundary drift', async () => {
  const f = fixture();
  outputRow(f).extra.deliveryBoundary.cursor = 'v2:0000000000000001:foreign';
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier refuses a committed output hidden from the target', async () => {
  const f = fixture();
  outputRow(f).visibility = 'whisper';
  outputRow(f).whisperTo = ['codex'];
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier refuses an empty committed answer', async () => {
  const f = fixture();
  outputRow(f).content = '   ';
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier preserves committed truth without reading or recreating auth', async () => {
  const f = fixture();
  const result = await classify(f);
  assert.equal(result.kind, 'committed');
  assert.equal(result.childInvocationId, childId);
  assert.deepEqual(result.witness, { kind: 'source_response', outputMessageIds: [outputId] });
  assert.equal(result.source.queueCustody.revision, sourceRow(f).queueCustody.revision);
});
test('classifier captures caller selection before the first read await', async () => {
  const f = fixture();
  const selection = { ...input };
  const messages = f.messages;
  // Async port wrapper must not replace the concrete memory adapter's synchronous
  // getById: its strict recovery reader uses that internal method synchronously.
  f.messages = {
    getById: async (id) => {
      selection.sourceMessageId = 'foreign';
      selection.catId = 'codex';
      return messages.getById(id);
    },
    findPublicInvocationOutput: messages.findPublicInvocationOutput.bind(messages),
    readPublicInvocationOutputRecovery: messages.readPublicInvocationOutputRecovery.bind(messages),
  };
  assert.equal((await classify(f, selection)).kind, 'committed');
});
test('classifier defers running child changed during later proof reads', async () => {
  const f = fixture('running', 'committed');
  const row = f.turns.get(childId);
  f.turns.get = () => row;
  const read = f.messages.findPublicInvocationOutput.bind(f.messages);
  f.messages.findPublicInvocationOutput = (...args) => {
    row.status = 'succeeded';
    row.endedAt = 1900;
    return read(...args);
  };
  const result = await classify(f);
  assert.equal(result.kind, 'deferred');
  assert.equal(result.reason, 'child_changed_during_read');
});
test('classifier defers a source changed while reading output instead of settling the old revision', async () => {
  const f = fixture();
  const read = f.messages.readPublicInvocationOutputRecovery.bind(f.messages);
  f.messages.readPublicInvocationOutputRecovery = (id) => {
    sourceRow(f).queueCustody.revision++;
    return read(id);
  };
  const result = await classify(f);
  assert.equal(result.kind, 'deferred');
  assert.equal(result.reason, 'source_changed_during_read');
});
test('classifier returns detached source and witness data', async () => {
  const f = fixture();
  const before = f.messages.getById(sourceId);
  const result = await classify(f);
  assert.equal(result.kind, 'committed');
  // Frozen data is also detached: attempted mutations must never alter canonical storage.
  try {
    result.source.content = 'changed';
  } catch {}
  result.witness.outputMessageIds.push('foreign');
  assert.deepEqual(f.messages.getById(sourceId), before);
  assert.deepEqual((await classify(f)).witness.outputMessageIds, [outputId]);
});
for (const side of ['child', 'outputs', 'recovery']) {
  test(`classifier rejects ${side} accessor without invoking it`, async () => {
    const f = fixture();
    let getters = 0;
    const accessor = (row, key) =>
      Object.defineProperty(row, key, {
        enumerable: true,
        get() {
          getters++;
          return 'foreign';
        },
      });
    if (side === 'child') {
      const row = f.turns.get(childId);
      accessor(row, 'userId');
      f.turns.get = () => row;
    }
    if (side === 'outputs') {
      const lookup = f.messages.findPublicInvocationOutput({
        userId: scope.userId,
        threadId: scope.threadId,
        sourceMessageId: sourceId,
        childInvocationId: childId,
      });
      accessor(lookup, 'outputMessageId');
      f.messages.findPublicInvocationOutput = () => lookup;
    }
    if (side === 'recovery') {
      const row = f.messages.readPublicInvocationOutputRecovery(outputId);
      accessor(row, 'message');
      f.messages.readPublicInvocationOutputRecovery = () => row;
    }
    assert.equal((await classify(f)).kind, 'conflict');
    assert.equal(getters, 0);
  });
}
test('classifier never calls message or child mutation APIs', async () => {
  const f = fixture();
  for (const method of [
    'append',
    'transitionQueueCustody',
    'transitionPublicInvocationOutput',
    'quarantinePublicInvocationOutput',
  ])
    f.messages[method] = () => assert.fail('classification must not write');
  f.turns.transitionTerminal = () => assert.fail('classification must not repair lifecycle');
  assert.equal((await classify(f)).kind, 'committed');
});
test('classifier does not require history hydration to preserve optional raw fields', async () => {
  const f = fixture();
  outputRow(f).mentionsUser = false;
  const read = f.messages.getByThreadAfter.bind(f.messages);
  f.messages.getByThreadAfter = (...args) =>
    read(...args).map((row) => {
      delete row.mentionsUser;
      return row;
    });
  assert.equal((await classify(f)).kind, 'committed');
});
test('classifier uses a newly finalized strict receipt discovered from a pending scan', async () => {
  const f = fixture('succeeded', 'pending');
  const read = f.messages.readPublicInvocationOutputRecovery.bind(f.messages);
  f.messages.readPublicInvocationOutputRecovery = (id) => {
    f.messages.transitionPublicInvocationOutput(id, { expected: f.expected, nextState: 'committed' });
    return read(id);
  };
  assert.equal((await classify(f)).kind, 'committed');
});
test('classifier refuses strict reader returning a different output id', async () => {
  const f = fixture();
  const row = f.messages.readPublicInvocationOutputRecovery(outputId);
  row.message.id = 'foreign';
  f.messages.readPublicInvocationOutputRecovery = () => row;
  assert.equal((await classify(f)).kind, 'conflict');
});

// Regression for Codex1217: one source classification must never enumerate its thread.
test('classifier discovery never enumerates the thread timeline', async () => {
  const f = fixture();
  const read = f.messages.getByThreadAfter.bind(f.messages);
  let timelineReads = 0;
  f.messages.getByThreadAfter = (...args) => {
    timelineReads++;
    return read(...args);
  };
  await classify(f);
  assert.equal(timelineReads, 0, 'source classification must use exact store-owned output discovery');
});

const lookupInput = {
  userId: scope.userId,
  threadId: scope.threadId,
  sourceMessageId: sourceId,
  childInvocationId: childId,
};
const lookup = (f, selection = lookupInput) => f.messages.findPublicInvocationOutput(selection);
const unique = { kind: 'unique', outputMessageId: outputId };
for (const state of ['pending', 'committed', 'abandoned', 'quarantined']) {
  test(`classifier exact discovery retains ${state} output after recovery index retirement`, () => {
    assert.deepEqual(lookup(fixture('succeeded', state)), unique);
  });
}
test('classifier exact discovery is empty for ordinary messages', () => {
  assert.deepEqual(lookup(fixture('running', 'none')), { kind: 'missing' });
});
test('classifier exact discovery rejects duplicate source with a different child', () => {
  const f = fixture();
  const second = structuredClone(f.expected);
  second.reservedId = '0000000000002100-000001-00000003';
  second.extra.publicOutputV1.outputMessageId = second.reservedId;
  second.extra.publicOutputV1.childInvocationId = 'other-child';
  second.extra.publicOutputV1.boundary.turnInvocationId = 'other-child';
  second.extra.stream.turnInvocationId = 'other-child';
  f.messages.append(second);
  assert.deepEqual(lookup(f), { kind: 'conflict' });
});
test('classifier exact discovery rejects duplicate child with a different source', () => {
  const f = fixture();
  const second = structuredClone(f.expected);
  second.reservedId = '0000000000002100-000001-00000003';
  second.extra.publicOutputV1.outputMessageId = second.reservedId;
  second.extra.publicOutputV1.sourceMessageId = 'other-source';
  second.extra.publicOutputV1.boundary.sourceMessageId = 'other-source';
  second.extra.causal.triggerMessageId = 'other-source';
  second.replyTo = 'other-source';
  f.messages.append(second);
  assert.deepEqual(lookup(f), { kind: 'conflict' });
});
test('classifier exact discovery retains soft deletion as non-consumable proof', async () => {
  const f = fixture('succeeded', 'pending');
  f.messages.softDelete(outputId, 'owner');
  assert.deepEqual(lookup(f), unique);
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier exact discovery retires hard deletion without authorizing replay', async () => {
  const f = fixture();
  f.messages.hardDelete(outputId, 'owner');
  assert.deepEqual(lookup(f), { kind: 'missing' });
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier exact discovery retires thread deletion', () => {
  const f = fixture();
  f.messages.deleteByThread(scope.threadId);
  assert.deepEqual(lookup(f), { kind: 'missing' });
  assert.equal(f.messages.publicOutputDiscovery.size, 0);
  assert.equal(f.messages.publicOutputDiscoveryById.size, 0);
});
test('classifier exact discovery stays bounded under terminal capacity eviction', () => {
  const f = fixture('running', 'none');
  f.messages = new MessageStore({ maxMessages: 1 });
  for (let i = 0; i < 50; i++) {
    const expected = structuredClone(f.expected);
    expected.reservedId = `0000000000002000-${String(i).padStart(6, '0')}-00000002`;
    expected.extra.publicOutputV1.outputMessageId = expected.reservedId;
    f.messages.append(expected);
    f.messages.transitionPublicInvocationOutput(expected.reservedId, { expected, nextState: 'committed' });
    assert.deepEqual(lookup(f), { kind: 'unique', outputMessageId: expected.reservedId });
    assert.equal(f.messages.publicOutputDiscovery.size, 2);
    assert.equal(f.messages.publicOutputDiscoveryById.size, 1);
  }
});
test('classifier exact discovery has no mutation on capacity rejection', () => {
  const f = fixture('running', 'none');
  f.messages = new MessageStore({ maxMessages: 0 });
  assert.throws(() => f.messages.append(f.expected));
  assert.deepEqual(lookup(f), { kind: 'missing' });
  assert.equal(f.messages.publicOutputDiscovery.size, 0);
});
test('classifier exact discovery does not duplicate an idempotent append winner', () => {
  const f = fixture('running', 'none');
  const expected = { ...f.expected, idempotencyKey: 'one' };
  assert.equal(f.messages.appendIdempotent(expected).idempotent, false);
  assert.equal(f.messages.appendIdempotent(expected).idempotent, true);
  assert.deepEqual(lookup(f), unique);
});
test('classifier exact discovery isolates owner and thread coordinates', () => {
  const f = fixture();
  for (const selection of [
    { ...lookupInput, userId: 'other' },
    { ...lookupInput, threadId: 'other' },
  ])
    assert.deepEqual(lookup(f, selection), { kind: 'missing' });
});
test('classifier exact discovery returns detached results', () => {
  const f = fixture();
  lookup(f).outputMessageId = 'foreign';
  assert.deepEqual(lookup(f), unique);
});
test('classifier refuses an unindexed legacy terminal output without history fallback', async () => {
  const f = fixture();
  f.messages.publicOutputDiscovery.clear();
  f.messages.getByThreadAfter = () => assert.fail('legacy discovery cannot scan');
  assert.equal((await classify(f)).kind, 'conflict');
});
test('classifier defers an output mapping changed during exact proof reads', async () => {
  const f = fixture();
  const find = f.messages.findPublicInvocationOutput.bind(f.messages);
  let reads = 0;
  f.messages.findPublicInvocationOutput = (selection) => (++reads === 1 ? find(selection) : { kind: 'conflict' });
  const result = await classify(f);
  assert.equal(result.kind, 'deferred');
  assert.equal(result.reason, 'output_mapping_changed_during_read');
});
test('classifier has a constant store read budget despite unrelated thread history', async () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++)
    f.messages.append({ ...scope, content: 'unrelated', mentions: [], timestamp: i + 3000 });
  const counts = {};
  for (const method of ['getById', 'findPublicInvocationOutput', 'readPublicInvocationOutputRecovery']) {
    const read = f.messages[method].bind(f.messages);
    // Bound original methods in a port wrapper so internal adapter calls are not counted twice.
    counts[method] = 0;
    counts[`${method}Read`] = read;
  }
  const port = Object.fromEntries(
    ['getById', 'findPublicInvocationOutput', 'readPublicInvocationOutputRecovery'].map((method) => [
      method,
      (...args) => {
        counts[method]++;
        return counts[`${method}Read`](...args);
      },
    ]),
  );
  port.getByThreadAfter = () => assert.fail('no timeline read');
  const getChild = f.turns.get.bind(f.turns);
  let childReads = 0;
  const turns = {
    get: (id) => {
      childReads++;
      return getChild(id);
    },
  };
  const result = await classifier({ ...f, messages: port, turns }).classify(input);
  assert.equal(result.kind, 'committed');
  assert.equal(childReads, 2);
  assert.equal(counts.getById, 3); // source, exact boundary, source revision reread
  assert.equal(counts.findPublicInvocationOutput, 2);
  assert.equal(counts.readPublicInvocationOutputRecovery, 1);
});
test('classifier preserves exact boundary read outage as deferred', async () => {
  const f = fixture();
  const get = f.messages.getById.bind(f.messages);
  let reads = 0;
  const port = {
    getById: (id) => {
      if (++reads === 2) throw Error('boundary outage');
      return get(id);
    },
    findPublicInvocationOutput: f.messages.findPublicInvocationOutput.bind(f.messages),
    readPublicInvocationOutputRecovery: f.messages.readPublicInvocationOutputRecovery.bind(f.messages),
  };
  assert.equal((await classifier({ ...f, messages: port }).classify(input)).kind, 'deferred');
});
function redisLookupFixture(raw) {
  const calls = [];
  const redis = {
    options: { keyPrefix: 'isolated:' },
    eval: async (...args) => {
      calls.push(args);
      return raw;
    },
  };
  return { messages: new RedisMessageStore(redis), calls };
}
test('classifier Redis discovery performs one bounded atomic lookup without hydration', async () => {
  const prefixes = publicOutputLookupPrefixes(lookupInput);
  const f = redisLookupFixture(prefixes.map((prefix) => [prefix + outputId]));
  assert.deepEqual(await lookup(f), unique);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(1), [1, 'msg:public-output:discovery:thread', 'owner', sourceId, childId]);
  assert.equal(f.calls[0][0], LOOKUP_PUBLIC_OUTPUT_LUA);
  assert.match(LOOKUP_PUBLIC_OUTPUT_LUA, /'LIMIT', 0, 2/);
  assert.doesNotMatch(LOOKUP_PUBLIC_OUTPUT_LUA, /HGETALL|ZRANGE[^\n]*0, -1|SMEMBERS/);
});
for (const [name, raw] of [
  ['empty', [[], []]],
  ['two candidates', [['a', 'b'], ['a']]],
  ['one dimension missing', [[publicOutputLookupPrefixes(lookupInput)[0] + outputId], []]],
  ['invalid index score or type', ['invalid_index']],
  ['malformed member', [['wrong'], ['wrong']]],
]) {
  test(`classifier Redis discovery fails closed for ${name}`, async () => {
    assert.deepEqual(await lookup(redisLookupFixture(raw)), { kind: name === 'empty' ? 'missing' : 'conflict' });
  });
}
test('classifier Redis discovery rejects accessors before backend access', async () => {
  const f = redisLookupFixture([[], []]);
  let reads = 0;
  const selection = { ...lookupInput };
  Object.defineProperty(selection, 'sourceMessageId', {
    enumerable: true,
    get() {
      reads++;
      return sourceId;
    },
  });
  await assert.rejects(() => lookup(f, selection));
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
});
test('classifier Redis discovery freezes identity across an await', async () => {
  const selection = { ...lookupInput };
  const prefixes = publicOutputLookupPrefixes(selection);
  const redis = {
    options: {},
    eval: async () => {
      selection.sourceMessageId = 'changed';
      return prefixes.map((prefix) => [prefix + outputId]);
    },
  };
  assert.deepEqual(await new RedisMessageStore(redis).findPublicInvocationOutput(selection), unique);
});
test('classifier discovery encoding cannot alias delimiters or Unicode coordinates', () => {
  const prefixes = [
    { ...lookupInput, userId: 'a:b', sourceMessageId: 'c' },
    { ...lookupInput, userId: 'a', sourceMessageId: 'b:c' },
    { ...lookupInput, userId: '猫', sourceMessageId: 'c' },
    { ...lookupInput, userId: 'e78cab', sourceMessageId: 'c' },
  ].map((value) => publicOutputLookupPrefixes(value)[0]);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test('classifier Redis append carries discovery identity in the same atomic append script', async () => {
  const f = fixture('running', 'none');
  const calls = [];
  const redis = {
    options: { keyPrefix: 'isolated:' },
    eval: async (script, count, ...args) => {
      calls.push({ script, count, args });
      assert.ok([APPEND_WITH_VISIBILITY_LUA, ENSURE_VISIBILITY_MIGRATED_LUA].includes(script));
      return 12345;
    },
  };
  const result = await new RedisMessageStore(redis).appendIdempotent(f.expected);
  assert.equal(result.idempotent, false);
  assert.equal(calls.length, 2); // existing migration check, then one atomic append, no separate index write
  const call = calls.find((call) => call.script === APPEND_WITH_VISIBILITY_LUA);
  assert.equal(call.count, 1);
  const argv = call.args.slice(1);
  const at = 9 + Number(argv[8]);
  const fields = argv.slice(at + 1);
  const hash = Object.fromEntries(
    Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]),
  );
  const receipt = JSON.parse(hash.extra).publicOutputV1;
  assert.equal(receipt.sourceMessageId, sourceId);
  assert.equal(receipt.childInvocationId, childId);
  assert.equal(argv[6], '0');
  assert.match(APPEND_WITH_VISIBILITY_LUA, /'ZADD', discoveryKey, 0, discoverySource/);
});
test('classifier Redis hard delete supplies the discovery key to its raw-fenced atomic delete', async () => {
  const calls = [];
  const hash = { id: outputId, threadId: scope.threadId, userId: scope.userId };
  const redis = {
    options: {},
    hgetall: async () => hash,
    eval: async (...args) => {
      calls.push(args);
      return [-1];
    },
  };
  assert.equal(await new RedisMessageStore(redis).hardDelete(outputId, 'owner'), null);
  assert.deepEqual(calls[0].slice(0, 5), [
    PUBLIC_OUTPUT_DELETE_LUA,
    3,
    `msg:${outputId}`,
    'msg:public-output:pending',
    'msg:public-output:discovery:thread',
  ]);
  assert.deepEqual(JSON.parse(calls[0][5]), Object.entries(hash));
});
test('classifier Redis thread deletion retires discovery in the same operation', async () => {
  const calls = [];
  const redis = {
    options: {},
    eval: async (...args) => {
      calls.push(args);
      return 2;
    },
  };
  assert.equal(await new RedisMessageStore(redis).deleteByThread(scope.threadId), 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], PUBLIC_OUTPUT_THREAD_DELETE_LUA);
  assert.equal(calls[0][1], 6);
  assert.equal(calls[0][7], 'msg:public-output:discovery:thread');
});
test('classifier Redis discovery preserves transport failure instead of inventing absence', async () => {
  const redis = {
    options: {},
    eval: async () => {
      throw Error('read unavailable');
    },
  };
  await assert.rejects(() => new RedisMessageStore(redis).findPublicInvocationOutput(lookupInput), /read unavailable/);
});
test('classifier discovery script guards key type and equal scores before its first write', () => {
  const firstWrite = APPEND_WITH_VISIBILITY_LUA.indexOf("redis.call('HSET', hash");
  assert.ok(firstWrite > 0);
  assert.ok(APPEND_WITH_VISIBILITY_LUA.indexOf('if not outputIndexValid(discoveryKey)') < firstWrite);
  const deleteWrite = PUBLIC_OUTPUT_DELETE_LUA.indexOf("redis.call('ZREM', KEYS[3]");
  assert.ok(deleteWrite > 0);
  assert.ok(PUBLIC_OUTPUT_DELETE_LUA.indexOf('if not outputIndexValid(KEYS[3])') < deleteWrite);
  assert.match(LOOKUP_PUBLIC_OUTPUT_LUA, /tonumber\(first\[2\]\) == 0 and tonumber\(last\[2\]\) == 0/);
});
