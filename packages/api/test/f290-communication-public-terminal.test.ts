import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCollectivePublicReplyTerminal } from '../src/domains/cats/services/agents/routing/collective-public-reply-terminal.js';
import { publicTerminalFixture } from './f290-communication-public-terminal.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

test('accepted public reply persists once independently of the ordinary routing guard', async (t) => {
  const f = await publicTerminalFixture();
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 2, 'business acceptance does not bypass the independently configured routing guard');
  assert.equal(Object.hasOwn(source, 'queueCustody'), false);
  const ref = source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === CAT);
  assert.ok(ref);
  assert.equal(ref.phase, 'settled');
  assert.equal(f.queue.size(f.thread.id, f.cafe.ownerUserId), 0);
  assert.equal((await f.context.readAcceptedPublicReply(f.lastAuth!))?.acceptedEventId, f.acceptedEventId);
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
  assert.equal(Object.hasOwn(source, 'queueCustody'), false);
  assert.equal(f.queue.size(f.thread.id, f.cafe.ownerUserId), 0);
  assert.equal(await f.context.readAcceptedPublicReply(f.lastAuth!), undefined);
});

test('accepted public business reply leaves an unrelated managed wake untouched', async (t) => {
  const f = await publicTerminalFixture({ otherHold: true });
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 2);
  assert.equal(Object.hasOwn(source, 'queueCustody'), false);
  assert.equal(source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === CAT)?.phase, 'settled');
  assert.ok(f.otherHoldId);
  const hold = await f.messages.getById(f.otherHoldId);
  assert.equal(hold?.source?.meta?.taskId, 'fixture-unsettled-hold');
  assert.equal(hold?.content, 'Existing managed hold wake');
  assert.deepEqual(hold?.lifecycle?.dispatchRefs ?? [], []);
  assert.equal(hold?.deliveryStatus, undefined);
  assert.equal(f.queue.size(f.thread.id, f.cafe.ownerUserId), 0);
});

test('accepted reply remains recorded when its exact provider execution fails', async (t) => {
  const f = await publicTerminalFixture({ providerFails: true });
  t.after(() => f.close());
  const { source, events } = await f.run();
  assert.equal(events.filter((event) => event.actor.kind === 'agent').length, 1);
  assert.equal(f.calls, 1);
  assert.equal(Object.hasOwn(source, 'queueCustody'), false);
  assert.equal(f.queue.size(f.thread.id, f.cafe.ownerUserId), 0);
  const execution = await f.executions.get(f.lastAuth!.invocationId);
  assert.equal(execution?.status, 'failed');
  assert.equal(execution?.terminalReason, 'provider_execution_failed');
  assert.equal(source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === CAT)?.phase, 'settled');
  assert.equal((await f.context.readAcceptedPublicReply(f.lastAuth!))?.acceptedEventId, f.acceptedEventId);
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
