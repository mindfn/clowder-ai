import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { CallbackAuthTurnExecutionLifecycle } from '../src/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.ts';
import { authTerminalFromTurnExecution } from '../src/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionProjection.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { PublicInvocationOutputCommitCoordinator } from '../src/domains/cats/services/agents/invocation/PublicInvocationOutputCommitCoordinator.ts';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

const barrierUrl = new URL(
  '../src/domains/cats/services/agents/invocation/TerminalProofRecoveryBarrier.ts',
  import.meta.url,
);
const workerUrl = new URL(
  '../src/domains/cats/services/agents/invocation/PublicOutputRecoveryService.ts',
  import.meta.url,
);
const barrierModule = existsSync(barrierUrl) ? await import(barrierUrl.href) : {};
const workerModule = existsSync(workerUrl) ? await import(workerUrl.href) : {};
function required(value, name) {
  assert.equal(typeof value, 'function', `missing public output proof recovery: ${name}`);
  return value;
}
function barrier() {
  return new (required(barrierModule.TerminalProofRecoveryBarrier, 'barrier'))();
}
function lifecycle(f) {
  return new CallbackAuthTurnExecutionLifecycle(f.turns, f.registry);
}
function repair(f) {
  const owner = lifecycle(f);
  return required(owner.reconcileExistingTerminal, 'auth repair').bind(owner);
}
const sourceId = '0000000000000001-000001-11111111';
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
async function fixture(status = 'succeeded', project = true, n = 2) {
  const registry = new InvocationRegistry({ startupRecoveryRequired: true });
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
    reservedId: `${String(n).padStart(16, '0')}-000001-22222222`,
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
        outputMessageId: `${String(n).padStart(16, '0')}-000001-22222222`,
        boundary,
      },
    },
  };
  messages.append(expected);
  return { registry, turns, messages, child, expected };
}

function worker(f, overrides = {}) {
  const proofBarrier = barrier();
  proofBarrier.markReady();
  const authLifecycle = lifecycle(f);
  const coordinator = new PublicInvocationOutputCommitCoordinator({
    messageStore: f.messages,
    turnExecutionStore: f.turns,
    registry: f.registry,
    proofBarrier,
  });
  return new (required(workerModule.PublicOutputRecoveryService, 'worker'))({
    messageStore: f.messages,
    coordinator,
    authLifecycle,
    proofBarrier,
    ...overrides,
  });
}
const read = (f) => f.messages.readPublicInvocationOutputRecovery(f.expected.reservedId);
const sweep = (service) => service.sweep({ limit: 1 });

test('proof recovery fixture has pending companion and canonical dual terminal with callback closed', async () => {
  const f = await fixture();
  assert.equal(read(f).kind, 'pending');
  assert.equal(f.registry.isStartupRecoveryComplete(), false);
  const auth = await f.registry.getRecord(f.child);
  assert.equal(auth.state, 'completed');
  assert.equal(auth.terminalRef, `turn_execution:${f.child}`);
});
test('proof recovery fixture exposes real active-auth terminal-child crash window', async () => {
  const f = await fixture('succeeded', false);
  assert.equal(f.turns.get(f.child).status, 'succeeded');
  assert.equal((await f.registry.getRecord(f.child)).state, 'active');
});
test('proof barrier starts closed and only moves to ready', () => {
  const b = barrier();
  assert.equal(b.isReady(), false);
  b.markReady();
  b.markReady();
  assert.equal(b.isReady(), true);
});
test('proof readiness permits output finalization while callback admission stays closed', async () => {
  const f = await fixture();
  const b = barrier();
  b.markReady();
  const c = new PublicInvocationOutputCommitCoordinator({
    messageStore: f.messages,
    turnExecutionStore: f.turns,
    registry: f.registry,
    proofBarrier: b,
  });
  assert.equal((await c.finalize({ expected: f.expected })).kind, 'committed');
  assert.equal(f.registry.isStartupRecoveryComplete(), false);
});
test('closed proof barrier blocks finalization even when callback global flag is open', async () => {
  const f = await fixture();
  const b = barrier();
  f.registry.markStartupRecoveryComplete();
  const c = new PublicInvocationOutputCommitCoordinator({
    messageStore: f.messages,
    turnExecutionStore: f.turns,
    registry: f.registry,
    proofBarrier: b,
  });
  assert.equal((await c.finalize({ expected: f.expected })).reason, 'startup_recovery_pending');
  assert.equal(read(f).kind, 'pending');
});
for (const status of ['succeeded', 'failed', 'canceled', 'interrupted']) {
  test(`narrow auth repair projects exact ${status} once without changing child`, async () => {
    const f = await fixture(status, false);
    const before = f.turns.get(f.child);
    const invoke = repair(f);
    assert.equal((await invoke(f.child)).kind, 'repaired');
    assert.equal((await invoke(f.child)).kind, 'already_consistent');
    const auth = await f.registry.getRecord(f.child),
      p = authTerminalFromTurnExecution(before);
    assert.equal(auth.state, p.disposition);
    assert.equal(auth.terminalRef, p.terminalRef);
    assert.equal(auth.endedAt, p.endedAt);
    assert.equal(auth.endReason, p.endReason);
    assert.deepEqual(f.turns.get(f.child), before);
  });
}
for (const [name, configure, kind] of [
  ['running child', () => {}, 'child_running'],
  [
    'missing child',
    (f) => {
      f.turns.get = () => null;
    },
    'missing_child',
  ],
  [
    'missing auth',
    (f) => {
      f.registry.getRecord = async () => null;
    },
    'missing_auth',
  ],
  [
    'read outage',
    (f) => {
      f.turns.get = () => {
        throw Error('read outage');
      };
    },
    'read_unavailable',
  ],
]) {
  test(`narrow auth repair preserves ${name} without creating or committing auth`, async () => {
    const f = await fixture('running', false);
    configure(f);
    let commits = 0;
    f.registry.commitTerminal = async () => {
      commits++;
      throw Error('forbidden write');
    };
    assert.equal((await repair(f)(f.child)).kind, kind);
    assert.equal(commits, 0);
  });
}
for (const field of ['parentInvocationId', 'userId', 'threadId', 'catId']) {
  test(`narrow auth repair rejects foreign ${field} before terminal write`, async () => {
    const f = await fixture('succeeded', false);
    const original = f.turns.get(f.child);
    f.turns.get = () => ({ ...original, [field]: 'foreign' });
    assert.equal((await repair(f)(f.child)).kind, 'terminal_conflict');
    assert.equal((await f.registry.getRecord(f.child)).state, 'active');
  });
}
test('narrow auth repair never replaces a conflicting first-write terminal', async () => {
  const f = await fixture('succeeded', false);
  await f.registry.commitTerminal({ invocationId: f.child, disposition: 'revoked', endedAt: 4, endReason: 'revoked' });
  const before = await f.registry.getRecord(f.child);
  assert.equal((await repair(f)(f.child)).kind, 'terminal_conflict');
  assert.deepEqual(await f.registry.getRecord(f.child), before);
});
test('proof startup stages set barrier only after auth then child recovery', async () => {
  const b = barrier(),
    calls = [];
  const run = required(barrierModule.recoverTerminalProofs, 'proof startup');
  await run({
    barrier: b,
    reconcileAuth: async () => {
      calls.push('auth');
      assert.equal(b.isReady(), false);
    },
    reconcileChildren: async () => {
      calls.push('child');
      assert.equal(b.isReady(), false);
    },
  });
  assert.deepEqual(calls, ['auth', 'child']);
  assert.equal(b.isReady(), true);
});
for (const stage of ['auth', 'child']) {
  test(`proof startup ${stage} failure leaves barrier closed`, async () => {
    const b = barrier();
    const run = required(barrierModule.recoverTerminalProofs, 'proof startup');
    await assert.rejects(
      run({
        barrier: b,
        reconcileAuth: async () => {
          if (stage === 'auth') throw Error('outage');
        },
        reconcileChildren: async () => {
          if (stage === 'child') throw Error('outage');
        },
      }),
      /outage/,
    );
    assert.equal(b.isReady(), false);
  });
}
for (const status of ['succeeded', 'failed', 'canceled', 'interrupted']) {
  test(`recovery worker settles ${status} without opening callback admission`, async () => {
    const f = await fixture(status);
    const result = await sweep(worker(f));
    assert.equal(result.kind, 'completed');
    assert.equal(result.outcomes[0].kind, status === 'succeeded' ? 'committed' : 'abandoned');
    assert.equal(read(f).kind, 'terminal');
    assert.equal(f.registry.isStartupRecoveryComplete(), false);
  });
}
test('recovery worker repairs active auth once and retries same exact expected snapshot', async () => {
  const f = await fixture('succeeded', false);
  const owner = lifecycle(f);
  let calls = 0;
  const original = required(owner.reconcileExistingTerminal, 'auth repair').bind(owner);
  owner.reconcileExistingTerminal = async (id) => {
    calls++;
    assert.equal(id, f.child);
    return original(id);
  };
  const result = await sweep(worker(f, { authLifecycle: owner }));
  assert.equal(result.outcomes[0].kind, 'committed');
  assert.equal(calls, 1);
});
for (const [name, configure, reason] of [
  [
    'lost auth',
    (f) => {
      f.registry.getRecord = async () => null;
    },
    'missing_terminal_proof',
  ],
  [
    'missing canonical child',
    (f) => {
      f.turns.get = () => null;
    },
    'missing_canonical_child',
  ],
  [
    'terminal contradiction',
    async (f) => {
      await f.registry.commitTerminal({
        invocationId: f.child,
        disposition: 'revoked',
        endedAt: 4,
        endReason: 'revoked',
      });
    },
    'terminal_projection_mismatch',
  ],
]) {
  test(`recovery worker quarantines ${name} and removes discovery without claiming answered`, async () => {
    const f = await fixture('succeeded', name !== 'terminal contradiction');
    await configure(f);
    const result = await sweep(worker(f));
    assert.equal(result.outcomes[0].kind, 'quarantined');
    assert.equal(read(f).reason, reason);
    assert.equal(f.messages.getById(f.expected.reservedId).extra.publicOutputV1.state, 'pending_terminal');
    assert.equal(f.messages.getById(f.expected.reservedId).extra.deliveryBoundary, undefined);
    assert.deepEqual(f.messages.scanPendingPublicInvocationOutputs({ limit: 10 }).ids, []);
  });
}
test('recovery worker advances durable checkpoint past deferred prefix across instances', async () => {
  const first = await fixture('running', false, 2),
    second = await fixture('succeeded', true, 3);
  first.messages.append(second.expected);
  const turns = { get: (id) => (id === first.child ? first.turns.get(id) : second.turns.get(id)) };
  const registry = {
    getRecord: (id) => (id === first.child ? first.registry.getRecord(id) : second.registry.getRecord(id)),
  };
  const f = { ...first, turns, registry };
  const a = await sweep(worker(f));
  assert.equal(a.outcomes[0].kind, 'deferred');
  assert.equal(a.exhausted, false);
  assert.equal(first.messages.getPublicInvocationOutputRecoveryCheckpoint().cursor, 'public-output:1');
  const b = await sweep(worker(f));
  assert.equal(b.outcomes[0].kind, 'committed');
  assert.equal(b.exhausted, true);
  assert.equal(first.messages.getPublicInvocationOutputRecoveryCheckpoint().cursor, null);
  assert.equal(read(first).kind, 'pending');
});
test('recovery worker read outage remains pending while bounded scan can progress', async () => {
  const f = await fixture();
  f.turns.get = () => {
    throw Error('read outage');
  };
  const result = await sweep(worker(f));
  assert.equal(result.outcomes[0].kind, 'deferred');
  assert.equal(read(f).kind, 'pending');
});
test('recovery worker recovers terminal CAS throw-after-apply without another terminal write', async () => {
  const f = await fixture();
  const original = f.messages.transitionPublicInvocationOutput.bind(f.messages);
  let calls = 0;
  f.messages.transitionPublicInvocationOutput = (...args) => {
    calls++;
    original(...args);
    throw Error('ack lost');
  };
  const a = await sweep(worker(f));
  assert.equal(a.outcomes[0].kind, 'deferred');
  assert.equal(read(f).kind, 'terminal');
  const b = await sweep(worker(f));
  assert.equal(b.outcomes.length, 0);
  assert.equal(calls, 1);
});
test('recovery worker retains malformed record as typed conflict and never invents expected identity', async () => {
  const f = await fixture();
  f.messages.messages[0].extra.publicOutputRecoveryV1.appendDigest = '0'.repeat(64);
  const result = await sweep(worker(f));
  assert.equal(result.outcomes[0].kind, 'malformed');
  assert.equal(read(f).kind, 'malformed');
  assert.equal(f.messages.scanPendingPublicInvocationOutputs({ limit: 10 }).ids.length, 1);
});
test('recovery worker retires dangling discovery only through store-owned absence fence', async () => {
  const f = await fixture();
  f.messages.messages = [];
  const result = await sweep(worker(f));
  assert.equal(result.outcomes[0].kind, 'missing');
  assert.deepEqual(f.messages.scanPendingPublicInvocationOutputs({ limit: 10 }).ids, []);
});
test('recovery worker with closed proof barrier performs no storage scan', async () => {
  const f = await fixture();
  const b = barrier();
  f.messages.getPublicInvocationOutputRecoveryCheckpoint = () => {
    throw Error('forbidden read');
  };
  const result = await sweep(worker(f, { proofBarrier: b }));
  assert.equal(result.kind, 'deferred');
  assert.equal(result.reason, 'startup_recovery_pending');
});
test('recovery worker refuses invalid limits before storage effects', async () => {
  const f = await fixture();
  const service = worker(f);
  for (const limit of [0, -1, 1.5, 1001]) await assert.rejects(service.sweep({ limit }));
  assert.equal(f.messages.getPublicInvocationOutputRecoveryCheckpoint().revision, 0);
});

for (const field of ['terminalRef', 'endedAt', 'endReason']) {
  test(`narrow auth repair refuses mismatched terminal ${field}`, async () => {
    const f = await fixture();
    const auth = await f.registry.getRecord(f.child);
    f.registry.getRecord = async () => ({ ...auth, [field]: field === 'endedAt' ? 9 : 'foreign' });
    f.registry.commitTerminal = async () => assert.fail('terminal must not be rewritten');
    assert.equal((await repair(f)(f.child)).kind, 'terminal_conflict');
  });
}
test('narrow auth repair captures child before auth await can mutate adapter data', async () => {
  const f = await fixture('succeeded', false);
  const child = f.turns.get(f.child);
  f.turns.get = () => child;
  const get = f.registry.getRecord.bind(f.registry);
  f.registry.getRecord = async (id) => {
    child.status = 'failed';
    child.terminalReason = 'mutated';
    return get(id);
  };
  assert.equal((await repair(f)(f.child)).kind, 'repaired');
  assert.equal((await get(f.child)).state, 'completed');
});
for (const side of ['child', 'auth']) {
  test(`narrow auth repair rejects ${side} accessor without executing it`, async () => {
    const f = await fixture('succeeded', false);
    const row = side === 'child' ? f.turns.get(f.child) : await f.registry.getRecord(f.child);
    let getters = 0;
    Object.defineProperty(row, 'userId', {
      enumerable: true,
      get: () => {
        getters++;
        return scope.userId;
      },
    });
    if (side === 'child') f.turns.get = () => row;
    else f.registry.getRecord = async () => row;
    f.registry.commitTerminal = async () => assert.fail('accessor cannot authorize write');
    assert.equal((await repair(f)(f.child)).kind, 'terminal_conflict');
    assert.equal(getters, 0);
  });
}
test('narrow auth repair classifies conflicting atomic winner without rereading it away', async () => {
  const f = await fixture('succeeded', false);
  const commit = f.registry.commitTerminal.bind(f.registry);
  f.registry.commitTerminal = async (input) => {
    await commit({ invocationId: f.child, disposition: 'revoked', endedAt: 4, endReason: 'winner' });
    return commit(input);
  };
  assert.equal((await repair(f)(f.child)).kind, 'terminal_conflict');
  assert.equal((await f.registry.getRecord(f.child)).state, 'revoked');
});
test('narrow auth repair does not recreate auth disappearing between read and commit', async () => {
  const f = await fixture('succeeded', false);
  f.registry.commitTerminal = async () => ({ outcome: 'not_found', record: null });
  f.registry.create = () => assert.fail('no credential mint');
  assert.equal((await repair(f)(f.child)).kind, 'missing_auth');
});
test('narrow auth repair handles lost terminal acknowledgement by canonical replay', async () => {
  const f = await fixture('succeeded', false);
  const commit = f.registry.commitTerminal.bind(f.registry);
  let writes = 0;
  f.registry.commitTerminal = async (input) => {
    writes++;
    await commit(input);
    throw Error('ack lost');
  };
  assert.equal((await repair(f)(f.child)).kind, 'read_unavailable');
  assert.equal((await repair(f)(f.child)).kind, 'already_consistent');
  assert.equal(writes, 1);
});
test('recovery worker defers one sweep after auth acknowledgement loss then settles without another auth write', async () => {
  const f = await fixture('succeeded', false);
  const commit = f.registry.commitTerminal.bind(f.registry);
  let writes = 0;
  f.registry.commitTerminal = async (input) => {
    writes++;
    await commit(input);
    throw Error('ack lost');
  };
  const service = worker(f);
  assert.equal((await sweep(service)).outcomes[0].kind, 'deferred');
  assert.equal((await sweep(service)).outcomes[0].kind, 'committed');
  assert.equal(writes, 1);
});
test('recovery worker permits only one same-instance sweep while storage is suspended', async () => {
  const f = await fixture();
  const get = f.messages.getPublicInvocationOutputRecoveryCheckpoint.bind(f.messages);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.messages.getPublicInvocationOutputRecoveryCheckpoint = async () => {
    await blocked;
    return get();
  };
  const service = worker(f);
  const first = sweep(service);
  assert.equal((await sweep(service)).reason, 'sweep_in_progress');
  release();
  assert.equal((await first).kind, 'completed');
});
test('recovery workers racing one checkpoint use CAS without clearing another scan position', async () => {
  const f = await fixture();
  const get = f.messages.getPublicInvocationOutputRecoveryCheckpoint.bind(f.messages);
  let reads = 0,
    release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  f.messages.getPublicInvocationOutputRecoveryCheckpoint = async () => {
    const checkpoint = get();
    if (++reads === 2) release();
    await blocked;
    return checkpoint;
  };
  const results = await Promise.all([sweep(worker(f)), sweep(worker(f))]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ['completed', 'conflict']);
  assert.equal(results.find((r) => r.kind === 'conflict').reason, 'checkpoint_conflict');
  assert.equal(get().revision, 1);
  assert.equal(read(f).kind, 'terminal');
});
test('recovery worker uses durable checkpoint after throw-after-apply without blind retry', async () => {
  const f = await fixture('running', false);
  const advance = f.messages.advancePublicInvocationOutputRecoveryCheckpoint.bind(f.messages);
  let writes = 0;
  f.messages.advancePublicInvocationOutputRecoveryCheckpoint = (input) => {
    writes++;
    const r = advance(input);
    if (writes === 1) throw Error('checkpoint ack lost');
    return r;
  };
  const service = worker(f);
  assert.equal((await sweep(service)).reason, 'checkpoint_unknown_applied');
  assert.equal(f.messages.getPublicInvocationOutputRecoveryCheckpoint().revision, 1);
  assert.equal((await sweep(service)).kind, 'completed');
  assert.equal(f.messages.getPublicInvocationOutputRecoveryCheckpoint().revision, 2);
  assert.equal(writes, 2);
});
test('recovery worker observes quarantine applied despite missing acknowledgement on next scan', async () => {
  const f = await fixture();
  f.registry.getRecord = async () => null;
  const quarantine = f.messages.quarantinePublicInvocationOutput.bind(f.messages);
  let writes = 0;
  f.messages.quarantinePublicInvocationOutput = (...args) => {
    writes++;
    quarantine(...args);
    throw Error('ack lost');
  };
  const service = worker(f);
  assert.equal((await sweep(service)).outcomes[0].reason, 'unknown_applied');
  assert.equal(read(f).kind, 'quarantined');
  assert.equal((await sweep(service)).outcomes.length, 0);
  assert.equal(writes, 1);
});
test('recovery worker never rewrites terminal winner racing quarantine', async () => {
  const f = await fixture();
  f.registry.getRecord = async () => null;
  const quarantine = f.messages.quarantinePublicInvocationOutput.bind(f.messages);
  f.messages.quarantinePublicInvocationOutput = (id, input) => {
    f.messages.transitionPublicInvocationOutput(id, { expected: input.expected, nextState: 'committed' });
    return quarantine(id, input);
  };
  assert.equal((await sweep(worker(f))).outcomes[0].kind, 'committed');
  assert.equal(read(f).kind, 'terminal');
});
test('recovery worker captures expected before repair await and uses identical snapshot for retry', async () => {
  const f = await fixture('succeeded', false);
  const original = structuredClone(read(f).expected);
  f.messages.readPublicInvocationOutputRecovery = () => ({ kind: 'pending', expected: original });
  let saved,
    calls = 0;
  const service = worker(f, {
    coordinator: {
      finalize: async ({ expected }) => {
        if (++calls === 1) {
          saved = expected;
          return { kind: 'deferred', reason: 'auth_reconciliation_pending' };
        }
        assert.equal(expected, saved);
        assert.equal(expected.content, 'public answer');
        return { kind: 'deferred', reason: 'child_running' };
      },
    },
    authLifecycle: {
      reconcileExistingTerminal: async () => {
        original.content = 'mutated';
        return { kind: 'repaired' };
      },
    },
  });
  await sweep(service);
  assert.equal(calls, 2);
});
test('recovery worker refuses accessor input without invoking it or scanning', async () => {
  const f = await fixture();
  let getters = 0;
  await assert.rejects(
    worker(f).sweep({
      get limit() {
        getters++;
        return 1;
      },
    }),
  );
  assert.equal(getters, 0);
  assert.equal(f.messages.getPublicInvocationOutputRecoveryCheckpoint().revision, 0);
});
test('recovery worker retains discovery when missing-row retirement fence loses', async () => {
  const f = await fixture();
  f.messages.readPublicInvocationOutputRecovery = () => ({ kind: 'missing' });
  assert.equal((await sweep(worker(f))).outcomes[0].reason, 'absence_fence_conflict');
  assert.equal(f.messages.scanPendingPublicInvocationOutputs({ limit: 1 }).ids.length, 1);
});
test('proof recovery startup preserves running children when ownership snapshot is incomplete', async () => {
  const f = await fixture('running', false);
  const b = barrier();
  await barrierModule.recoverTerminalProofs({
    barrier: b,
    reconcileAuth: () => lifecycle(f).reconcileStartup({ processStartedAt: Date.now() }),
    reconcileChildren: async () => ({ skippedReason: 'cli_execution_owner_snapshot_incomplete' }),
  });
  assert.equal(b.isReady(), true);
  assert.equal(f.turns.get(f.child).status, 'running');
  assert.equal((await sweep(worker(f, { proofBarrier: b }))).outcomes[0].reason, 'child_running');
  assert.equal(f.registry.isStartupRecoveryComplete(), false);
});
test('actual bootstrap binds independent proof stages and bounded output page before global admission', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('address = await listenBeforeTurnExecutionRecovery');
  const end = source.indexOf('onRecoveryError:', start);
  const bootstrap = source.slice(start, end);
  const stages = [
    'await recoverTerminalProofs(',
    'reconcileAuth: () => turnExecutionStore.reconcileStartup(',
    'reconcileChildren: async () =>',
    'await publicOutputRecovery.sweep({ limit: 100 })',
    'await reconciler.reconcileOrphans()',
    'registry.markStartupRecoveryComplete()',
    'await queueProcessor.processNext(',
  ];
  let last = -1;
  for (const stage of stages) {
    const position = bootstrap.indexOf(stage);
    assert.ok(position > last, `startup phase misplaced: ${stage}`);
    last = position;
  }
  assert.match(source, /sessionHookAuthenticationReady = \(\) => registry\.isStartupRecoveryComplete\(\)/);
  assert.match(source, /if \(publicOutputRecoveryTick\) return/);
  assert.match(source, /await publicOutputRecoveryTick/);
});

test('recovery worker quarantines real GC lost proof without reminting auth', async () => {
  const f = await fixture();
  const now = Date.now;
  const future = now() + 31 * 24 * 60 * 60 * 1000;
  try {
    Date.now = () => future;
    assert.equal(await f.registry.getRecord(f.child), null);
  } finally {
    Date.now = now;
  }
  f.registry.create = () => assert.fail('must not recreate GC auth');
  const result = await sweep(worker(f));
  assert.equal(result.outcomes[0].kind, 'quarantined');
  assert.equal(read(f).reason, 'missing_terminal_proof');
});
test('recovery worker does not read auth for a terminal row discovered by a stale page', async () => {
  const f = await fixture();
  const scan = f.messages.scanPendingPublicInvocationOutputs.bind(f.messages);
  f.messages.scanPendingPublicInvocationOutputs = (input) => {
    const page = scan(input);
    f.messages.transitionPublicInvocationOutput(f.expected.reservedId, {
      expected: f.expected,
      nextState: 'committed',
    });
    return page;
  };
  f.registry.getRecord = () => assert.fail('terminal replay must outlive auth GC');
  assert.equal((await sweep(worker(f))).outcomes[0].kind, 'committed');
});
test('recovery worker retains malformed expected accessor without invoking or quarantining it', async () => {
  const f = await fixture();
  const expected = structuredClone(read(f).expected);
  let getters = 0;
  Object.defineProperty(expected, 'content', {
    enumerable: true,
    get: () => {
      getters++;
      return 'public answer';
    },
  });
  f.messages.readPublicInvocationOutputRecovery = () => ({ kind: 'pending', expected });
  f.messages.quarantinePublicInvocationOutput = () => assert.fail('no trusted expected identity');
  assert.equal((await sweep(worker(f))).outcomes[0].kind, 'malformed');
  assert.equal(getters, 0);
  assert.equal(f.messages.scanPendingPublicInvocationOutputs({ limit: 1 }).ids.length, 1);
});
test('recovery worker rejects nonprogressing page before acting on output or checkpoint', async () => {
  const f = await fixture();
  f.messages.scanPendingPublicInvocationOutputs = () => ({ ids: [], exhausted: false });
  f.messages.advancePublicInvocationOutputRecoveryCheckpoint = () =>
    assert.fail('must not reset nonprogressing cursor');
  const result = await sweep(worker(f));
  assert.equal(result.kind, 'deferred');
  assert.equal(read(f).kind, 'pending');
});

for (const protectedOwner of [false, true]) {
  test(`proof startup wrapper projects child interruption before output recovery with protected=${protectedOwner}`, async () => {
    const { TurnExecutionStartupReconciler } = await import(
      '../src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts'
    );
    const f = await fixture('running', false);
    const b = barrier();
    const owner = lifecycle(f);
    await barrierModule.recoverTerminalProofs({
      barrier: b,
      reconcileAuth: () => owner.reconcileStartup({ processStartedAt: 10 }),
      reconcileChildren: () =>
        new TurnExecutionStartupReconciler({ store: owner, now: () => 20 }).reconcile({
          processStartedAt: 10,
          ...(protectedOwner ? { protectedInvocationIds: [f.child] } : {}),
        }),
    });
    const result = await sweep(worker(f, { proofBarrier: b }));
    assert.equal(result.outcomes[0].kind, protectedOwner ? 'deferred' : 'abandoned');
    assert.equal(f.turns.get(f.child).status, protectedOwner ? 'running' : 'interrupted');
    assert.equal((await f.registry.getRecord(f.child)).state, protectedOwner ? 'active' : 'interrupted');
    assert.equal(f.registry.isStartupRecoveryComplete(), false);
  });
}
