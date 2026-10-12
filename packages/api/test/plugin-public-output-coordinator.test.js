import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { authTerminalFromTurnExecution } from '../src/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionProjection.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { committedPublicInvocationOutput } from '../src/domains/cats/services/stores/public-invocation-output.ts';

const moduleUrl = new URL(
  '../src/domains/cats/services/agents/invocation/PublicInvocationOutputCommitCoordinator.ts',
  import.meta.url,
);
const Coordinator = existsSync(moduleUrl)
  ? (await import(moduleUrl.href)).PublicInvocationOutputCommitCoordinator
  : undefined;
const sourceId = '0000000000000001-000001-11111111';
const outputId = '0000000000000002-000001-22222222';
const scope = { userId: 'owner', threadId: 'public-thread', catId: 'codex' };
const policy = {
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'native',
  actionMethods: ['native.read'],
};
const binding = {
  version: 1,
  entryId: 'entry',
  carrier: {
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
    targetCatId: 'codex',
    authorityRef: 'authority',
    authorityRevision: 'r1',
  },
};
async function fixture(status = 'succeeded', project = true) {
  const registry = new InvocationRegistry();
  const turns = new InMemoryTurnExecutionStore();
  const messages = new MessageStore();
  const { invocationId: child } = await registry.create(
    scope.userId,
    scope.catId,
    scope.threadId,
    'parent',
    undefined,
    policy,
    sourceId,
    'unknown',
    undefined,
    binding,
  );
  turns.createRunning({
    invocationId: child,
    parentInvocationId: 'parent',
    ...scope,
    executionKind: 'ordinary',
    queueCompletionPolicy: 'explicit_source',
    startedAt: 1,
    causal: { triggerMessageId: sourceId, coveredMessageIds: [sourceId] },
  });
  if (status !== 'running') {
    turns.transitionTerminal(child, {
      status,
      endedAt: 3,
      ...(status !== 'succeeded' ? { terminalReason: 'fixture_failure' } : {}),
    });
    if (project) await registry.commitTerminal(authTerminalFromTurnExecution(turns.get(child)));
  }
  const boundary = {
    v: 1,
    ...scope,
    sourceMessageId: sourceId,
    turnInvocationId: child,
    cursor: cursorFor({ ...scope, catId: null, id: sourceId, timestamp: 1, visibilitySeq: 1 }),
  };
  const expected = {
    ...scope,
    reservedId: outputId,
    timestamp: 2,
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
        outputMessageId: outputId,
        boundary,
      },
    },
  };
  messages.append(expected);
  const calls = { reads: 0, cas: 0, auth: 0, turns: 0 };
  const deps = {
    messageStore: {
      getById: (id) => {
        assert.equal(id, outputId, 'coordinator must not read source/custody');
        calls.reads++;
        return messages.getById(id);
      },
      transitionPublicInvocationOutput: (id, input) => {
        calls.cas++;
        return messages.transitionPublicInvocationOutput(id, input);
      },
    },
    turnExecutionStore: {
      get: (id) => {
        assert.equal(id, child);
        calls.turns++;
        return turns.get(id);
      },
    },
    registry: {
      getRecord: (id) => {
        assert.equal(id, child);
        calls.auth++;
        return registry.getRecord(id);
      },
      isStartupRecoveryComplete: () => registry.isStartupRecoveryComplete(),
    },
  };
  return { registry, turns, messages, child, expected, deps, calls };
}
function coordinator(f) {
  assert.equal(typeof Coordinator, 'function', 'missing canonical public output commit coordinator');
  return new Coordinator(f.deps);
}
const pending = (f) => assert.equal(f.messages.getById(outputId).extra.publicOutputV1.state, 'pending_terminal');
async function assertResult(f, kind, reason) {
  const result = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(result.kind, kind);
  if (reason) assert.equal(result.reason, reason);
  if (kind === 'deferred' || kind === 'conflict') {
    pending(f);
    assert.equal(f.calls.cas, 0);
  }
  return result;
}

test('coordinator fixture has exact public identity and canonical terminal projection', async () => {
  const f = await fixture();
  const turn = f.turns.get(f.child);
  const auth = await f.registry.getRecord(f.child);
  const projection = authTerminalFromTurnExecution(turn);
  assert.equal(turn.status, 'succeeded');
  assert.equal(auth.state, projection.disposition);
  assert.equal(auth.terminalRef, projection.terminalRef);
  assert.equal(auth.endedAt, projection.endedAt);
  assert.equal(auth.endReason, projection.endReason);
  assert.deepEqual(auth.publicInvocationBinding, binding);
  assert.deepEqual(turn.causal.coveredMessageIds, [sourceId]);
  pending(f);
  assert.equal(committedPublicInvocationOutput(f.messages.getById(outputId)), undefined);
});
for (const status of ['succeeded', 'failed', 'canceled', 'interrupted']) {
  test(`coordinator settles exact canonical ${status} without mutating lifecycle stores`, async () => {
    const f = await fixture(status);
    const beforeTurn = f.turns.get(f.child);
    const beforeAuth = await f.registry.getRecord(f.child);
    const kind = status === 'succeeded' ? 'committed' : 'abandoned';
    const result = await assertResult(f, kind);
    assert.equal(result.message.extra.publicOutputV1.state, kind);
    assert.equal(Boolean(committedPublicInvocationOutput(result.message)), kind === 'committed');
    assert.equal(f.calls.cas, 1);
    assert.deepEqual(f.turns.get(f.child), beforeTurn);
    assert.deepEqual(await f.registry.getRecord(f.child), beforeAuth);
  });
}
for (const [label, status, configure, reason] of [
  ['running child', 'running', () => {}, 'child_running'],
  ['active auth', 'succeeded', () => {}, 'auth_reconciliation_pending'],
  [
    'startup incomplete',
    'succeeded',
    (f) => {
      f.deps.registry.isStartupRecoveryComplete = () => false;
    },
    'startup_recovery_pending',
  ],
  [
    'missing auth before startup',
    'succeeded',
    (f) => {
      f.deps.registry.isStartupRecoveryComplete = () => false;
      f.deps.registry.getRecord = async () => null;
    },
    'startup_recovery_pending',
  ],
  [
    'child read outage',
    'succeeded',
    (f) => {
      f.deps.turnExecutionStore.get = async () => {
        throw Error('read outage');
      };
    },
    'read_unavailable',
  ],
  [
    'auth read outage',
    'succeeded',
    (f) => {
      f.deps.registry.getRecord = async () => {
        throw Error('read outage');
      };
    },
    'read_unavailable',
  ],
]) {
  test(`coordinator defers ${label}`, async () => {
    const f = await fixture(status, label !== 'active auth');
    configure(f);
    await assertResult(f, 'deferred', reason);
  });
}
for (const [label, configure, reason] of [
  [
    'missing canonical child',
    (f) => {
      f.deps.turnExecutionStore.get = async () => null;
    },
    'missing_canonical_child',
  ],
  [
    'missing terminal proof',
    (f) => {
      f.deps.registry.getRecord = async () => null;
    },
    'missing_terminal_proof',
  ],
]) {
  test(`coordinator classifies ${label} after startup as conflict without replay`, async () => {
    const f = await fixture();
    configure(f);
    await assertResult(f, 'conflict', reason);
  });
}
for (const state of ['failed', 'interrupted', 'replaced', 'revoked', 'canceled']) {
  test(`coordinator rejects succeeded child with ${state} auth`, async () => {
    const f = await fixture('succeeded', false);
    await f.registry.commitTerminal({ ...authTerminalFromTurnExecution(f.turns.get(f.child)), disposition: state });
    await assertResult(f, 'conflict', 'terminal_projection_mismatch');
  });
}
for (const [label, side, mutate] of [
  [
    'foreign parent',
    'turn',
    (r) => {
      r.parentInvocationId = 'other';
    },
  ],
  [
    'foreign user',
    'auth',
    (r) => {
      r.userId = 'other';
    },
  ],
  [
    'extra covered source',
    'turn',
    (r) => {
      r.causal.coveredMessageIds.push('other');
    },
  ],
  [
    'missing covered source',
    'turn',
    (r) => {
      delete r.causal.coveredMessageIds;
    },
  ],
  [
    'foreign source',
    'auth',
    (r) => {
      r.publicInvocationBinding.carrier.sourceMessageId = 'other';
    },
  ],
  [
    'widened policy',
    'auth',
    (r) => {
      r.toolExecutionPolicy.actionMethods.push('native.admin');
    },
  ],
]) {
  test(`coordinator rejects ${label} identity`, async () => {
    const f = await fixture();
    const original = side === 'turn' ? f.turns.get(f.child) : await f.registry.getRecord(f.child);
    const record = structuredClone(original);
    mutate(record);
    if (side === 'turn') f.deps.turnExecutionStore.get = async () => record;
    else f.deps.registry.getRecord = async () => record;
    await assertResult(f, 'conflict', 'identity_mismatch');
  });
}
test('coordinator preserves committed output after auth proof GC without rereading lifecycle', async () => {
  const f = await fixture();
  f.messages.transitionPublicInvocationOutput(outputId, { expected: f.expected, nextState: 'committed' });
  f.deps.registry.getRecord = async () => {
    throw Error('auth GC must not downgrade committed output');
  };
  f.deps.turnExecutionStore.get = async () => {
    throw Error('must reuse durable output proof');
  };
  const result = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(result.kind, 'committed');
  assert.ok(committedPublicInvocationOutput(result.message));
});
test('coordinator reports CAS conflict without retry or manufactured success', async () => {
  const f = await fixture();
  coordinator(f);
  f.deps.messageStore.transitionPublicInvocationOutput = async () => {
    f.calls.cas++;
    return { kind: 'conflict' };
  };
  const result = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(result.kind, 'conflict');
  assert.equal(f.calls.cas, 1);
  pending(f);
});
test('coordinator reports unknown applied CAS error and permits exact idempotent recovery', async () => {
  const f = await fixture();
  coordinator(f);
  const original = f.deps.messageStore.transitionPublicInvocationOutput;
  f.deps.messageStore.transitionPublicInvocationOutput = async (...args) => {
    original(...args);
    throw Error('lost acknowledgement');
  };
  const first = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(first.kind, 'deferred');
  assert.equal(first.reason, 'unknown_applied');
  f.deps.messageStore.transitionPublicInvocationOutput = original;
  const next = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(next.kind, 'committed');
  assert.ok(committedPublicInvocationOutput(next.message));
});
test('coordinator freezes caller snapshot before first storage await', async () => {
  const f = await fixture();
  const c = coordinator(f);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  f.deps.messageStore.getById = async () => waiting;
  const input = { expected: structuredClone(f.expected) };
  const execution = c.finalize(input);
  input.expected.content = 'private pollution';
  release(f.messages.getById(outputId));
  assert.equal((await execution).kind, 'committed');
  assert.equal(f.messages.getById(outputId).content, 'public answer');
});
for (const accessor of [false, true]) {
  test(`coordinator rejects caller-supplied authority ${accessor ? 'accessor' : 'flag'} before I/O`, async () => {
    const f = await fixture();
    const c = coordinator(f);
    const input = accessor
      ? Object.defineProperty({}, 'expected', {
          get() {
            throw Error('getter executed');
          },
          enumerable: true,
        })
      : { expected: f.expected, success: true };
    await assert.rejects(() => c.finalize(input), /public.*output|output.*coordinator/i);
    assert.equal(f.calls.reads + f.calls.auth + f.calls.turns + f.calls.cas, 0);
  });
}
test('coordinator refuses output snapshot drift before terminalization', async () => {
  const f = await fixture();
  f.expected.content = 'different body';
  await assertResult(f, 'conflict', 'output_mismatch');
});

for (const [field, value] of [
  ['terminalRef', 'turn_execution:foreign'],
  ['endedAt', 4],
  ['endReason', 'wrong reason'],
]) {
  test(`coordinator rejects mismatched terminal projection ${field}`, async () => {
    const f = await fixture();
    const auth = { ...(await f.registry.getRecord(f.child)), [field]: value };
    f.deps.registry.getRecord = async () => auth;
    await assertResult(f, 'conflict', 'terminal_projection_mismatch');
  });
}
test('coordinator rejects failed child with completed auth', async () => {
  const f = await fixture('failed', false);
  await f.registry.commitTerminal({ ...authTerminalFromTurnExecution(f.turns.get(f.child)), disposition: 'completed' });
  await assertResult(f, 'conflict', 'terminal_projection_mismatch');
});
for (const [label, side, mutate] of [
  [
    'foreign thread',
    'turn',
    (r) => {
      r.threadId = 'other';
    },
  ],
  [
    'foreign cat',
    'auth',
    (r) => {
      r.catId = 'astra';
    },
  ],
  [
    'foreign child',
    'turn',
    (r) => {
      r.invocationId = 'other';
    },
  ],
  [
    'nonordinary execution',
    'turn',
    (r) => {
      r.executionKind = 'routing_guard';
    },
  ],
  [
    'ordinary queue completion',
    'turn',
    (r) => {
      delete r.queueCompletionPolicy;
    },
  ],
  [
    'owner principal',
    'auth',
    (r) => {
      r.ownerAuthProvenance = 'strict';
    },
  ],
  [
    'managed work',
    'auth',
    (r) => {
      r.managedWorkBinding = { workId: 'w', attemptId: 'a' };
    },
  ],
  [
    'A2A identity',
    'auth',
    (r) => {
      r.a2aTriggerMessageId = sourceId;
    },
  ],
  [
    'absent public marker',
    'auth',
    (r) => {
      delete r.publicInvocationBinding;
    },
  ],
  [
    'malformed public marker',
    'auth',
    (r) => {
      r.publicInvocationBinding = {};
    },
  ],
]) {
  test(`coordinator rejects ${label} before output CAS`, async () => {
    const f = await fixture();
    const record = structuredClone(side === 'turn' ? f.turns.get(f.child) : await f.registry.getRecord(f.child));
    mutate(record);
    if (side === 'turn') f.deps.turnExecutionStore.get = async () => record;
    else f.deps.registry.getRecord = async () => record;
    await assertResult(f, 'conflict', 'identity_mismatch');
  });
}
test('coordinator defers output read outage without reading lifecycle', async () => {
  const f = await fixture();
  f.deps.messageStore.getById = async () => {
    throw Error('read outage');
  };
  await assertResult(f, 'deferred', 'read_unavailable');
  assert.equal(f.calls.auth + f.calls.turns, 0);
});
test('coordinator snapshots running child before later auth read advances terminal truth', async () => {
  const f = await fixture('running');
  const child = f.turns.get(f.child);
  f.deps.turnExecutionStore.get = async () => child;
  f.deps.registry.getRecord = async () => {
    f.turns.transitionTerminal(f.child, { status: 'succeeded', endedAt: 3 });
    Object.assign(child, f.turns.get(f.child));
    await f.registry.commitTerminal(authTerminalFromTurnExecution(child));
    return f.registry.getRecord(f.child);
  };
  const c = coordinator(f);
  assert.equal((await c.finalize({ expected: f.expected })).kind, 'deferred');
  assert.equal(f.calls.cas, 0);
  assert.equal((await c.finalize({ expected: f.expected })).kind, 'committed');
});
test('coordinator rejects nonterminal canonical CAS acknowledgement', async () => {
  const f = await fixture();
  f.deps.messageStore.transitionPublicInvocationOutput = async () => ({
    kind: 'updated',
    message: f.messages.getById(outputId),
  });
  const result = await coordinator(f).finalize({ expected: f.expected });
  assert.equal(result.kind, 'conflict');
  assert.equal(result.reason, 'invalid_storage_receipt');
  pending(f);
});
test('coordinator returns detached committed results', async () => {
  const f = await fixture();
  const result = await coordinator(f).finalize({ expected: f.expected });
  result.message.content = 'mutated';
  result.message.extra.publicOutputV1.state = 'pending_terminal';
  assert.equal(f.messages.getById(outputId).content, 'public answer');
  assert.ok(committedPublicInvocationOutput(f.messages.getById(outputId)));
});
for (const state of ['committed', 'abandoned']) {
  test(`coordinator terminal ${state} replay never calls potentially writing CAS`, async () => {
    const f = await fixture();
    f.messages.transitionPublicInvocationOutput(outputId, { expected: f.expected, nextState: state });
    f.deps.messageStore.transitionPublicInvocationOutput = async () => {
      throw Error('must not promote a recreated row using old proof');
    };
    assert.equal((await coordinator(f).finalize({ expected: f.expected })).kind, state);
    assert.equal(f.calls.auth + f.calls.turns, 0);
  });
}
for (const side of ['turn', 'auth']) {
  test(`coordinator rejects ${side} record accessor without invoking it`, async () => {
    const f = await fixture();
    const record = side === 'turn' ? f.turns.get(f.child) : await f.registry.getRecord(f.child);
    let getters = 0;
    Object.defineProperty(record, 'userId', {
      enumerable: true,
      get() {
        getters++;
        return scope.userId;
      },
    });
    if (side === 'turn') f.deps.turnExecutionStore.get = async () => record;
    else f.deps.registry.getRecord = async () => record;
    await assertResult(f, 'conflict', 'identity_mismatch');
    assert.equal(getters, 0);
  });
}
for (const committed of [false, true]) {
  test(`coordinator handles real auth tombstone GC for ${committed ? 'committed' : 'pending'} output`, async () => {
    const f = await fixture();
    if (committed)
      f.messages.transitionPublicInvocationOutput(outputId, { expected: f.expected, nextState: 'committed' });
    const originalNow = Date.now;
    const future = originalNow() + 31 * 24 * 60 * 60 * 1000;
    try {
      Date.now = () => future;
      assert.equal(await f.registry.getRecord(f.child), null);
    } finally {
      Date.now = originalNow;
    }
    const result = await coordinator(f).finalize({ expected: f.expected });
    assert.equal(result.kind, committed ? 'committed' : 'conflict');
    if (!committed) {
      assert.equal(result.reason, 'missing_terminal_proof');
      pending(f);
    }
    assert.equal(f.calls.cas, 0);
  });
}
