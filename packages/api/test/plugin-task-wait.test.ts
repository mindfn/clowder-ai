import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTypedWaitContinuation } from '../src/domains/ball-custody/TypedWaitContinuation.js';
import { WaitContinuationRetryPreflight } from '../src/domains/ball-custody/WaitContinuationRetryPreflight.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/plugin-task-host.js';

const identity = {
  invocationId: 'inv',
  userId: 'owner',
  catId: 'codex',
  threadId: 'thread',
  sourceMessageId: 'message',
};
const caller = {
  ...identity,
  source: { kind: 'primary' as const, sourceMessageId: 'message' },
  assertCurrent: async () => {},
};
const initial = { expectedGeneration: null, generation: 1, active: {} };
function fixture() {
  const store = new TaskStore();
  const host = createPluginTaskHost({
    pluginId: 'example',
    pluginInstanceId: 'instance',
    effectiveGrants: ['task.read', 'task.write'],
    taskStore: store,
  });
  const native = <T>(run: () => Promise<T>) => withPluginCallContext('instance', caller, run);
  return { store, host, native };
}

for (const kind of ['pr_tracking', 'issue_tracking'] as const) {
  test(`done ${kind} accepts first terminal repair but never an active wait or a rebound receipt`, async () => {
    const { store, host, native } = fixture();
    const task = await native(() =>
      host.create({
        threadId: 'thread',
        ownerCatId: 'codex',
        title: 'Completed tracking',
        kind,
        subjectKey: `${kind === 'pr_tracking' ? 'pr' : 'issue'}:fixture/repo#1`,
      }),
    );
    await store.update(task.id, { status: 'done' });
    const terminal = {
      ...initial,
      active: null,
      outcome: {
        outcomeId: 'terminal',
        generation: 1,
        ownerFence: { kind: 'containing_task' as const, generation: 1 },
        reason: 'subject_terminal' as const,
        delivery: 'pending' as const,
      },
    };
    await assert.rejects(host.setWait(task.id, terminal), /authenticated/);
    assert.equal(await native(() => host.setWait(task.id, initial)), null);
    assert.equal(await native(() => host.setWait(task.id, { ...initial, active: null })), null);
    assert.equal(store.get(task.id)!.pluginWait, undefined);
    const repaired = await native(() => host.setWait(task.id, terminal));
    assert.ok(repaired, 'first terminal projection must repair the failed initial publication');
    assert.equal(repaired.status, 'done');
    assert.equal(repaired.pluginWait?.await, undefined);
    assert.equal(repaired.pluginWait?.waitOutcome?.outcomeId, 'terminal');
    assert.equal(repaired.pluginWait?.registration?.invocationId, caller.invocationId);
    const replay = await withPluginCallContext(
      'instance',
      {
        ...caller,
        invocationId: 'retry-turn',
        source: { kind: 'primary', sourceMessageId: 'new-source' },
      },
      () => host.setWait(task.id, { ...terminal, expectedGeneration: 1 }),
    );
    assert.deepEqual(replay?.pluginWait, repaired.pluginWait);
    assert.equal(await native(() => host.setWait(task.id, terminal)), null, 'stale CAS is rejected');
    await assert.rejects(
      withPluginCallContext('instance', { ...caller, userId: 'other' }, () =>
        host.setWait(task.id, { ...terminal, expectedGeneration: 1 }),
      ),
      /another/,
    );
  });
}

test('authenticated plugin wait supports exact-source continuation and outcome retry without provider state', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'External event', kind: 'work' }),
  );
  assert.equal(task.userId, 'owner');
  await native(() => host.setWait(task.id, initial));
  const saved = await host.get(task.id);
  assert.equal(saved?.automationState, undefined);
  assert.equal(saved?.deploymentWait, undefined);
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'bypass');
  assert.equal(
    (await resolveTypedWaitContinuation({ taskStore: store, ...identity, invocationId: 'other' })).kind,
    'reject',
  );
  const outcome = {
    outcomeId: 'outcome',
    generation: 1,
    ownerFence: { kind: 'containing_task' as const, generation: 1 },
    reason: 'matched' as const,
    delivery: 'pending' as const,
  };
  await host.setWait(task.id, { expectedGeneration: 1, generation: 1, active: null, outcome });
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  const retry = new WaitContinuationRetryPreflight({ taskStore: store });
  const request = {
    requestingUserId: 'owner',
    targetCatId: 'codex',
    message: {
      catId: null,
      userId: 'owner',
      threadId: 'thread',
      source: {
        connector: 'github-wait',
        meta: {
          waitContinuationCarrier: { v: 1, waitId: task.id, outcomeId: 'outcome', ownerFence: outcome.ownerFence },
        },
      },
    },
  };
  assert.deepEqual(await retry.preflight(request as never), { ok: true, kind: 'wait_containing_task' });
  await host.setWait(task.id, { expectedGeneration: 1, generation: 2, active: {} });
  assert.equal((await retry.preflight(request as never)).ok, false);
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  assert.equal(await host.setWait(task.id, { expectedGeneration: 1, generation: 1, active: {} }), null);
});

test('wait projection binds its instance and owner and requires authenticated first registration', async () => {
  const { store, host, native } = fixture();
  const task = await native(() => host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'Wait' }));
  await assert.rejects(host.setWait(task.id, initial));
  await native(() => host.setWait(task.id, initial));
  const other = createPluginTaskHost({
    pluginId: 'other',
    pluginInstanceId: 'other',
    effectiveGrants: ['task.write'],
    taskStore: store,
  });
  await assert.rejects(other.setWait(task.id, { expectedGeneration: 1, generation: 1, active: null }));
  await store.update(task.id, { ownerCatId: 'opus' as never });
  await assert.rejects(host.setWait(task.id, { expectedGeneration: 1, generation: 2, active: {} }));
});

test('renewal can retain the preceding outcome; exact replay never rebinds an existing registration', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({
      threadId: 'thread',
      ownerCatId: 'codex',
      title: 'Wait',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#1',
    }),
  );
  await native(() => host.setWait(task.id, initial));
  const receipt = store.get(task.id)!.pluginWait!.registration;
  await withPluginCallContext('instance', { ...caller, invocationId: 'retry-turn' }, () =>
    host.setWait(task.id, { ...initial, expectedGeneration: 1 }),
  );
  assert.deepEqual(store.get(task.id)!.pluginWait!.registration, receipt);
  const outcome = {
    outcomeId: 'old-event',
    generation: 1,
    ownerFence: { kind: 'containing_task' as const, generation: 1 },
    reason: 'matched' as const,
    delivery: 'pending' as const,
  };
  const renewed = await host.setWait(task.id, { expectedGeneration: 1, generation: 2, active: {}, outcome });
  assert.equal(renewed?.pluginWait?.generation, 2);
  assert.equal(renewed?.pluginWait?.waitOutcome?.generation, 1);
  assert.equal(renewed?.pluginWait?.registration, undefined);
  assert.equal(renewed?.pluginWait?.await?.expiresAt, undefined);
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  const request = {
    requestingUserId: 'owner',
    targetCatId: 'codex',
    message: {
      catId: null,
      userId: 'owner',
      threadId: 'thread',
      source: {
        connector: 'github-wait',
        meta: {
          waitContinuationCarrier: { v: 1, waitId: task.id, outcomeId: 'old-event', ownerFence: outcome.ownerFence },
        },
      },
    },
  };
  assert.equal((await new WaitContinuationRetryPreflight({ taskStore: store }).preflight(request as never)).ok, true);
  await host.setWait(task.id, { expectedGeneration: 2, generation: 2, active: {} });
  assert.equal(store.get(task.id)!.pluginWait!.waitOutcome, undefined, 'omission clears outcome in full snapshot');
  await assert.rejects(
    host.setWait(task.id, {
      expectedGeneration: 2,
      generation: 2,
      active: {},
      outcome: { ...outcome, ownerFence: { kind: 'action_successor', leaseId: 'forged', generation: 1 } },
    } as never),
  );
});

test('expiry, concurrent same-generation publication and stale invocation fail closed', async () => {
  const { store, host, native } = fixture();
  const task = await native(() => host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'Wait' }));
  await native(() => host.setWait(task.id, { ...initial, active: { expiresAt: Date.now() - 1 } }));
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  const old = store.get(task.id)!.pluginWait!;
  const replacement = { ...old, generation: 2, await: { generation: 2 } };
  assert.ok(store.replacePluginWait(task.id, { expectedGeneration: 1, expectedState: old, state: replacement }));
  assert.equal(
    store.replacePluginWait(task.id, { expectedGeneration: 2, expectedState: old, state: replacement }),
    null,
  );
  await assert.rejects(
    withPluginCallContext(
      'instance',
      {
        ...caller,
        assertCurrent: async () => {
          throw Error('stale');
        },
      },
      () => host.setWait(task.id, { expectedGeneration: 2, generation: 3, active: {} }),
    ),
  );
  assert.equal(store.get(task.id)!.pluginWait!.generation, 2);
});
