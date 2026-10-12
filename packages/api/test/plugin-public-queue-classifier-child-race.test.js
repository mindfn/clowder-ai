import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts';
import { TerminalProofRecoveryBarrier } from '../src/domains/cats/services/agents/invocation/TerminalProofRecoveryBarrier.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { assertQueuedMessageCustody } from '../src/domains/cats/services/stores/ports/queued-message-custody.ts';

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

const changed = (result, reason = 'child_changed_during_read') =>
  assert.deepEqual(
    { kind: result.kind, reason: result.reason },
    { kind: 'deferred', reason },
    'child epoch must revalidate exact child before returning bound result',
  );
function finish(f, status) {
  f.turns.transitionTerminal(childId, {
    status,
    endedAt: 1900,
    ...(status === 'succeeded' ? {} : { terminalReason: 'fixture_failure' }),
  });
  assert.equal(f.turns.get(childId).status, status);
  assert.equal(
    f.messages.transitionPublicInvocationOutput(outputId, {
      expected: f.expected,
      nextState: status === 'succeeded' ? 'committed' : 'abandoned',
    }).kind,
    'updated',
  );
}
test('child epoch control: stable succeeded and committed is consumable', async () => {
  assert.equal((await classify(fixture())).kind, 'committed');
});
test('child epoch control: stable failed and abandoned is terminal', async () => {
  assert.equal((await classify(fixture('failed', 'abandoned'))).kind, 'abandoned');
});
test('child epoch control: stable running and committed remains a contradiction', async () => {
  assert.equal((await classify(fixture('running', 'committed'))).kind, 'conflict');
});
test('child epoch control: stable foreign child identity remains conflict', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  f.turns.get = (id) => ({ ...get(id), userId: 'foreign' });
  assert.equal((await classify(f)).kind, 'conflict');
});
test('child epoch defers real running to succeeded with committed output during lookup', async () => {
  const f = fixture('running', 'pending');
  const read = f.messages.findPublicInvocationOutput.bind(f.messages);
  let transitioned = false;
  f.messages.findPublicInvocationOutput = (selection) => {
    if (!transitioned) {
      transitioned = true;
      finish(f, 'succeeded');
    }
    return read(selection);
  };
  changed(await classify(f));
  assert.equal((await classify(f)).kind, 'committed');
});
test('child epoch defers real running to failed with abandoned output during recovery read', async () => {
  const f = fixture('running', 'pending');
  const read = f.messages.readPublicInvocationOutputRecovery.bind(f.messages);
  let transitioned = false;
  f.messages.readPublicInvocationOutputRecovery = (id) => {
    if (!transitioned) {
      transitioned = true;
      finish(f, 'failed');
    }
    return read(id);
  };
  changed(await classify(f));
  assert.equal((await classify(f)).kind, 'abandoned');
});
test('child epoch defers changed child even when output remains pending', async () => {
  const f = fixture('running', 'pending');
  const read = f.messages.findPublicInvocationOutput.bind(f.messages);
  let transitioned = false;
  f.messages.findPublicInvocationOutput = (selection) => {
    if (!transitioned) {
      transitioned = true;
      f.turns.transitionTerminal(childId, { status: 'succeeded', endedAt: 1900 });
    }
    return read(selection);
  };
  changed(await classify(f));
});
test('child epoch preserves final child read outage as deferred', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0;
  f.turns.get = (id) => {
    if (++reads > 1) throw Error('read unavailable');
    return get(id);
  };
  changed(await classify(f), 'read_unavailable');
});
test('child epoch defers child disappearance between observations', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0;
  f.turns.get = (id) => (++reads === 1 ? get(id) : null);
  changed(await classify(f));
});
test('child epoch defers child identity drift instead of returning old committed proof', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0;
  f.turns.get = (id) => (++reads === 1 ? get(id) : { ...get(id), parentInvocationId: 'foreign' });
  changed(await classify(f));
});

test('child epoch includes the final source await in its observation interval', async () => {
  const f = fixture('running', 'pending');
  const messages = f.messages;
  let sourceReads = 0;
  const port = {
    getById: (id) => {
      if (id === sourceId && ++sourceReads === 2) finish(f, 'succeeded');
      return messages.getById(id);
    },
    findPublicInvocationOutput: messages.findPublicInvocationOutput.bind(messages),
    readPublicInvocationOutputRecovery: messages.readPublicInvocationOutputRecovery.bind(messages),
  };
  changed(await classifier({ ...f, messages: port }).classify(input));
});
test('child epoch revalidates even an initially missing child decision', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0;
  f.turns.get = (id) => (++reads === 1 ? null : get(id));
  changed(await classify(f));
});
test('child epoch revalidates an initially foreign identity before permanent conflict', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0;
  f.turns.get = (id) => (++reads === 1 ? { ...get(id), userId: 'foreign' } : get(id));
  changed(await classify(f));
});
test('child epoch revalidates the early missing output branch', async () => {
  const f = fixture('running', 'none');
  const read = f.messages.findPublicInvocationOutput.bind(f.messages);
  f.messages.findPublicInvocationOutput = (selection) => {
    f.turns.transitionTerminal(childId, { status: 'succeeded', endedAt: 1900 });
    return read(selection);
  };
  changed(await classify(f));
});
test('child epoch rejects final child accessors without invoking them', async () => {
  const f = fixture();
  const get = f.turns.get.bind(f.turns);
  let reads = 0,
    getters = 0;
  f.turns.get = (id) => {
    const row = get(id);
    if (++reads > 1)
      Object.defineProperty(row, 'status', {
        enumerable: true,
        get() {
          getters++;
          return 'succeeded';
        },
      });
    return row;
  };
  assert.equal((await classify(f)).kind, 'conflict');
  assert.equal(getters, 0);
});
test('child epoch keeps a stable missing canonical child as conflict', async () => {
  const f = fixture();
  let reads = 0;
  f.turns.get = () => {
    reads++;
    return null;
  };
  const result = await classify(f);
  assert.equal(result.kind, 'conflict');
  assert.equal(result.reason, 'missing_canonical_child');
  assert.equal(reads, 2);
});
