import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueuedMessageCustodyCoordinator } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { normalizeQueueTerminalConsumptions } from '../src/domains/cats/services/agents/invocation/queue-terminal-consumption.js';
import { readCollectivePublicReplyTerminal } from '../src/domains/cats/services/agents/routing/collective-public-reply-terminal.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { assertCollectivePublicReplyBindings } from '../src/domains/cats/services/stores/ports/queued-message-custody.js';
import { publicTerminalFixture } from './f290-communication-public-terminal.fixture.js';
import { CAT, until } from './f290-communication-validation.host.js';
import { verifyPublicReplyCustody } from './f290-public-reply-custody.fixture.js';

test('accepted public reply settles its exact source with one ordinary production route execution', async (t) => {
  const f = await publicTerminalFixture();
  t.after(() => f.close());
  const { request, source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 1, 'accepted source must not invoke an extra routing_guard provider');
  assert.equal(source.queueCustody?.status, 'terminal');
  assert.deepEqual(source.queueCustody?.handledByCatIds, [CAT]);
  assert.deepEqual(source.queueCustody?.targetOutcomeByCatId?.[CAT]?.consumption, {
    kind: 'collective_public_reply',
    sourceMessageId: source.id,
    sourceEventId: request.eventId,
    acceptedEventId: f.acceptedEventId,
  });
});

test('accepted resolver is read-only and fails closed across authority and operation mismatches', async (t) => {
  const f = await publicTerminalFixture();
  t.after(() => f.close());
  await f.run();
  assert.ok(f.lastAuth?.executionGrant);
  const auth = f.lastAuth;
  const before = await f.stateBytes();
  const prepare = f.cafe.connector.prepareReply;
  f.cafe.connector.prepareReply = () => {
    throw new Error('read resolver must never prepare');
  };
  t.after(() => {
    f.cafe.connector.prepareReply = prepare;
  });
  const valid = await f.context.readAcceptedPublicReply(auth);
  assert.equal(valid?.acceptedEventId, f.acceptedEventId);
  assert.deepEqual(await f.stateBytes(), before);
  const retry = await f.registry.create(
    auth.userId,
    auth.catId,
    auth.threadId,
    undefined,
    undefined,
    { mode: 'collective_participation' },
    auth.originTriggerMessageId,
    'unknown',
    undefined,
    auth.executionGrant,
  );
  const retryAuth = await f.registry.peekRecord(retry.invocationId);
  assert.ok(retryAuth && retryAuth.invocationId !== auth.invocationId);
  assert.equal(
    (await f.context.readAcceptedPublicReply(retryAuth))?.acceptedEventId,
    f.acceptedEventId,
    'accepted lost-response recovery remains source/cat-bound rather than provider-session-bound',
  );
  const mutations = [
    { userId: 'wrong-owner' },
    { threadId: 'wrong-thread' },
    { catId: 'codex-terra' },
    { originTriggerMessageId: 'wrong-source' },
    { executionGrant: undefined },
    { ownerAuthProvenance: 'strict_owner' as const },
    { toolExecutionPolicy: undefined },
    { collectiveWorkBinding: {} as NonNullable<typeof auth.collectiveWorkBinding> },
    {
      executionGrant: { ...auth.executionGrant, source: { ...auth.executionGrant.source, participationRevision: 100 } },
    },
  ];
  for (const mutation of mutations) {
    assert.equal(
      await f.context.readAcceptedPublicReply({ ...auth, ...mutation }),
      undefined,
      JSON.stringify(mutation),
    );
  }
  const read = f.cafe.connector.readPublicReply.bind(f.cafe.connector);
  const operation = read(auth.executionGrant!.source, `message:${auth.originTriggerMessageId}`);
  assert.ok(operation);
  for (const status of ['prepared', 'queued', 'sending', 'blocked'] as const) {
    f.cafe.connector.readPublicReply = () => ({ ...operation, status });
    assert.equal(await f.context.readAcceptedPublicReply(auth), undefined, status);
  }
  for (const mutation of [
    { acceptedEventId: '' },
    { sourceRef: 'message:wrong' },
    { replySource: undefined },
    { agent: { ...operation.agent!, catId: 'codex-terra' } },
    { workPurpose: { taskRef: 'task:work:private', admittedRevision: 1, resultRevision: 1 } },
  ]) {
    f.cafe.connector.readPublicReply = () => ({ ...operation, ...mutation });
    assert.equal(await f.context.readAcceptedPublicReply(auth), undefined);
  }
  f.cafe.connector.readPublicReply = () => undefined;
  assert.equal(await f.context.readAcceptedPublicReply(auth), undefined);
  f.cafe.connector.readPublicReply = read;
  const route = await f.cafe.connector.getHostRoute(f.cafe.connectionId);
  assert.ok(route);
  const { connectionId: _connection, revision, updatedAt: _updated, ...config } = route;
  await f.cafe.connector.setHostRoute(f.cafe.connectionId, { ...config, agentRoutes: {} }, revision);
  assert.equal(await f.context.readAcceptedPublicReply(auth), undefined, 'revoked/old participation stays blocked');
});

test('provider forged accepted DTO never supplies a public terminal or skips the guard', async (t) => {
  const f = await publicTerminalFixture({ forgedReply: true });
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 0);
  assert.equal(f.calls, 2, 'unaccepted source retains original stop-gate behavior');
  assert.notEqual(source.queueCustody?.targetOutcomeByCatId?.[CAT]?.consumption?.kind, 'collective_public_reply');
  assert.equal(await f.context.readAcceptedPublicReply(f.lastAuth!), undefined);
});

test('Queue public witness binds exact message/event/cat/owner/scope and rejects malformed payload', async (t) => {
  const f = await publicTerminalFixture();
  t.after(() => f.close());
  const { source } = await f.run();
  const custody = source.queueCustody!;
  assertCollectivePublicReplyBindings(source, custody);
  for (const mutation of [{ id: 'wrong' }, { userId: 'wrong' }, { catId: CAT }, { source: undefined }]) {
    assert.throws(
      () => assertCollectivePublicReplyBindings({ ...source, ...mutation }, custody),
      /exact durable source/,
    );
  }
  for (const field of ['sourceMessageId', 'sourceEventId', 'acceptedEventId'] as const) {
    const invalid = structuredClone(custody);
    const witness = invalid.targetOutcomeByCatId![CAT].consumption!;
    assert.equal(witness.kind, 'collective_public_reply');
    if (witness.kind === 'collective_public_reply') witness[field] = field === 'acceptedEventId' ? '' : 'wrong';
    assert.throws(() => assertCollectivePublicReplyBindings(source, invalid), /exact durable source/);
  }
  for (const scope of [undefined, 'collective-work'] as const) {
    assert.throws(
      () => assertCollectivePublicReplyBindings(source, { ...custody, executionScope: scope }),
      /exact durable source/,
    );
  }
  assert.throws(
    () =>
      assertCollectivePublicReplyBindings(source, {
        ...custody,
        targetOutcomeByCatId: { 'codex-terra': custody.targetOutcomeByCatId![CAT] },
      }),
    /exact durable source/,
  );
  assert.deepEqual(
    normalizeQueueTerminalConsumptions({ kind: 'collective_public_reply', sourceMessageId: source.id }),
    [],
  );
});

test('accepted public primary never clears an adopted managed-hold disposition', async (t) => {
  const f = await publicTerminalFixture({ adoptHold: true });
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 1, 'adopted structured failure stays on this exact invocation, never a new model');
  assert.equal(
    f.broadcasts.some((event) => event.errorCode === 'managed_hold_disposition_missing'),
    true,
  );
  assert.notEqual(
    source.queueCustody?.targetOutcomeByCatId?.[CAT]?.consumption?.kind,
    'collective_public_reply',
    'this change cannot supply a success witness for a failed aggregate; existing exact local source-response rules remain',
  );
  const execution = await f.executions.get(f.lastAuth!.invocationId);
  assert.ok(execution?.parentInvocationId);
  assert.equal(f.records.get(execution.parentInvocationId)?.status, 'failed');
});

test('accepted reply does not change aggregate provider-failure Queue rules', async (t) => {
  const f = await publicTerminalFixture({ providerFails: true });
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 1);
  assert.notEqual(source.queueCustody?.targetOutcomeByCatId?.[CAT]?.consumption?.kind, 'collective_public_reply');
  const execution = await f.executions.get(f.lastAuth!.invocationId);
  assert.ok(execution?.parentInvocationId);
  assert.equal(f.records.get(execution.parentInvocationId)?.status, 'failed');
});

for (const scenario of [{ providerFails: true }, { adoptHold: true }]) {
  test(`fixture waits for exact source settlement after tracker release: ${JSON.stringify(scenario)}`, async (t) => {
    const f = await publicTerminalFixture(scenario);
    const original = QueuedMessageCustodyCoordinator.prototype.commitSuccessfulTargetsForMessages;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = false;
    let released = false;
    let observedPendingSource = false;
    let prematureVisibleRead = false;
    t.mock.method(
      QueuedMessageCustodyCoordinator.prototype,
      'commitSuccessfulTargetsForMessages',
      async function (this: QueuedMessageCustodyCoordinator, ...args: Parameters<typeof original>) {
        reached = true;
        await barrier;
        return original.apply(this, args);
      },
    );
    const includingQueued = f.messages.getByThreadIncludingQueued.bind(f.messages);
    t.mock.method(f.messages, 'getByThreadIncludingQueued', (...args: Parameters<typeof includingQueued>) => {
      const sources = includingQueued(...args);
      if (reached && !released) {
        observedPendingSource ||= sources.some((source) => source.queueCustody?.status === 'queued');
      }
      return sources;
    });
    const visible = f.messages.getByThread.bind(f.messages);
    t.mock.method(f.messages, 'getByThread', (...args: Parameters<typeof visible>) => {
      if (reached && !released) prematureVisibleRead = true;
      return visible(...args);
    });
    t.after(async () => {
      release();
      await f.close();
    });
    const running = f.run();
    void running.catch(() => {}); // Keep the intentional pre-fix rejection observed until the assertion below.
    await until(() => reached && !f.tracker.has(f.thread.id), 'tracker released before blocked source CAS');
    await until(() => observedPendingSource || prematureVisibleRead, 'fixture observes pending source settlement');
    assert.equal(prematureVisibleRead, false, 'fixture must not read the visible timeline before source settlement');
    released = true;
    release();
    const { source, events } = await running;
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.queueCustody?.status, 'terminal');
    assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
    assert.equal(f.calls, 1);
    assert.notEqual(source.queueCustody?.targetOutcomeByCatId?.[CAT]?.consumption?.kind, 'collective_public_reply');
    assert.ok(f.lastAuth);
    const execution = await f.executions.get(f.lastAuth.invocationId);
    assert.ok(execution?.parentInvocationId);
    assert.equal(f.records.get(execution.parentInvocationId)?.status, 'failed');
  });
}

test('memory CAS persists only a source-bound public reply witness', async () => {
  await verifyPublicReplyCustody(new MessageStore());
});

test('consumer lookup failure and structured/private wakes fail closed without consulting the public resolver', async (t) => {
  const f = await publicTerminalFixture();
  t.after(() => f.close());
  const { source } = await f.run();
  const input = {
    executionScope: 'collective-participation',
    wake: { kind: 'legacy' as const, reason: 'carrier_missing' as const },
    source,
    userId: f.cafe.ownerUserId,
    threadId: f.thread.id,
    catId: CAT,
    invocationId: f.lastAuth!.invocationId,
    registry: f.registry,
    collectiveContext: () => f.context,
  };
  assert.equal((await readCollectivePublicReplyTerminal(input))?.acceptedEventId, f.acceptedEventId);
  assert.equal(
    await readCollectivePublicReplyTerminal({
      ...input,
      registry: {
        peekRecord: async () => {
          throw new Error('fixture registry unavailable');
        },
      },
    }),
    undefined,
  );
  let consulted = false;
  const collectiveContext = () => {
    consulted = true;
    throw new Error('wrong scope consulted');
  };
  for (const scope of [undefined, 'collective-work']) {
    assert.equal(
      await readCollectivePublicReplyTerminal({ ...input, executionScope: scope, collectiveContext }),
      undefined,
    );
  }
  for (const wake of [
    {
      kind: 'structured' as const,
      protocol: 'hold' as const,
      subjectKey: 'ball:thread:x',
      holderCatId: CAT,
      sourceMessageId: source.id,
      taskId: 'hold',
    },
    {
      kind: 'structured' as const,
      protocol: 'dispatch' as const,
      subjectKey: 'ball:thread:x',
      holderCatId: CAT,
      handoff: { sourceEventId: 'route:source', messageId: source.id, fromCatId: 'opus' },
    },
    { kind: 'action_successor' as const, leaseId: 'lease', generation: 1, holderCatId: CAT },
  ])
    assert.equal(await readCollectivePublicReplyTerminal({ ...input, wake, collectiveContext }), undefined);
  assert.equal(consulted, false);
});
