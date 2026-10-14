import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { dotProactiveFixture as fixture } from './helpers/f247-dot-proactive-fixture.js';

test('same shared connection asks as dot; canonical Queue returns actual local replies to the original subscription', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const b = f.thread('B');
    const viaRemote = (t: string, key: string) =>
      f.remote.rpc('tools/call', {
        name: 'cat_cafe_dot_ask',
        arguments: {
          attempt_id: f.setup.attemptId,
          thread_id: t,
          target_cat_ids: ['codex'],
          content: '请回答这一问',
          client_message_id: key,
        },
      });
    const [ra, rb] = await Promise.all([viaRemote(a.id, 'A'), viaRemote(b.id, 'B')]);
    assert.equal(ra.error, undefined, JSON.stringify(ra));
    assert.equal(rb.error, undefined, JSON.stringify(rb));
    const roots = [ra, rb].map((r) => f.messages.getById(r.result.structuredContent.messageId)!);
    assert.ok(roots.every((root) => root.catId === 'gpt-dot' && root.extra?.dotAsk));
    for (const root of roots)
      assert.ok(
        f.queue
          .list(root.threadId, 'owner')
          .some((e) => e.callerCatId === 'gpt-dot' && e.a2aTriggerMessageId === root.id),
      );
    const replies = await Promise.all(roots.map((root) => f.reply(root.id, root.threadId, 'codex', undefined, true)));
    for (const r of replies) {
      assert.deepEqual(r.mentions, ['gpt-dot'], 'explicit and automatic dot targets must merge');
      assert.ok(
        f.queue
          .list(r.threadId, 'owner')
          .some((e) => e.targetCats.includes('gpt-dot') && e.a2aTriggerMessageId === r.id),
      );
      assert.equal((await f.deliver(r.id)).kind, 'sent');
      assert.equal((await f.deliver(r.id)).kind, 'sent');
    }
    assert.equal(f.events.length, 2);
    assert.deepEqual(new Set(f.events.map((e) => e.data.thread_id)), new Set([a.id, b.id]));
    for (const event of f.events)
      assert.equal(
        (await f.returns.read(f.setup.credentialSecret, event.eventId)).source.id,
        event.data.source_message_id,
      );
    assert.deepEqual(
      (await f.connection.current())!.allowedCatIds,
      [],
      'one-question reply is not a permanent summon grant',
    );
  } finally {
    await f.close();
  }
});

test('owner replies to a dot question through ordinary summon authority and dot can read the delivered source', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('owner reply');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const source = f.messages.append({
      userId: 'owner',
      threadId: thread.id,
      catId: null,
      replyTo: rootId,
      content: '@dot 补充一点背景',
      mentions: [createCatId('gpt-dot')],
      timestamp: Date.now(),
    });
    assert.equal((await f.deliver(source.id)).kind, 'sent');
    assert.equal(f.events.length, 1);
    assert.equal((await f.returns.read(f.setup.credentialSecret, f.events[0].eventId)).source.id, source.id);
    assert.deepEqual((await f.connection.current())?.allowedCatIds, []);
  } finally {
    await f.close();
  }
});

test('durable dot request key survives retries, conflicts across threads, and rejects caller identity overrides', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const b = f.thread('B');
    const results = await Promise.all([f.ask(a.id), f.ask(a.id)]);
    assert.ok(
      results.every((r) => r.result),
      JSON.stringify(results),
    );
    assert.equal(results[0].result.structuredContent.messageId, results[1].result.structuredContent.messageId);
    assert.equal((await f.ask(a.id)).result.structuredContent.messageId, results[0].result.structuredContent.messageId);
    for (const conflict of [await f.ask(a.id, 'request', '变了'), await f.ask(b.id)])
      assert.equal(conflict.error.data.reason, 'dot_ask_idempotency_conflict');
    assert.equal((await f.ask(f.thread('other', 'other').id, 'other')).error.data.reason, 'dot_ask_thread_rejected');
    const args = {
      attempt_id: f.setup.attemptId,
      thread_id: a.id,
      target_cat_ids: ['codex'],
      content: 'x',
      client_message_id: 'x',
    };
    for (const field of ['author', 'catId', 'owner', 'subscription_id', 'replyTo', 'proactive'])
      assert.ok((await f.rpc({ ...args, [field]: 'forged' })).error);
    const generic = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': f.setup.credentialSecret },
      payload: { threadId: a.id, content: '伪造主动准入', targetCats: ['codex'] },
    });
    assert.equal(generic.statusCode, 403);
    f.disable();
    assert.equal((await f.ask(a.id, 'disabled')).error.data.reason, 'dot_disabled');
  } finally {
    await f.close();
  }
});

test('replyTo alone, unrelated executions, non-recipients, and stale subscriptions cannot forward a reply', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const r = await f.ask(a.id);
    assert.ok(r.result, JSON.stringify(r));
    const root = r.result.structuredContent.messageId as string;
    const unrelated = f.messages.append({
      userId: 'owner',
      threadId: a.id,
      catId: null,
      content: 'other',
      mentions: [],
      timestamp: Date.now(),
    });
    const wrongExecution = await f.reply(unrelated.id, a.id, 'codex', root);
    const nonrecipient = await f.reply(root, a.id, 'sonnet');
    for (const source of [wrongExecution, nonrecipient]) assert.notEqual((await f.deliver(source.id)).kind, 'sent');
    const actual = await f.reply(root, a.id);
    await f.connection.begin('owner', true);
    assert.notEqual((await f.deliver(actual.id)).kind, 'sent');
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});

test('withdrawn recipients and replaced execution witnesses cannot use a consultation reply permission', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('withdrawn');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const answer = await f.reply(rootId, thread.id);
    const root = f.messages.getById(rootId)!;
    assert.ok(root.queueCustody);
    const original = structuredClone(root.queueCustody);
    root.queueCustody.withdrawnByCatIds = ['codex' as never];
    assert.notEqual(
      (await f.deliver(answer.id)).kind,
      'sent',
      'a withdrawn target has no residual consultation authority',
    );
    root.queueCustody = { ...original, awakenedInvocationIdByCatId: { codex: 'replacement-child' } };
    assert.notEqual(
      (await f.deliver(answer.id)).kind,
      'sent',
      'an old child must not answer after a replacement was created',
    );
    root.queueCustody = original;
    assert.equal(
      (await f.deliver(answer.id)).kind,
      'sent',
      'the original authority remains valid without those changes',
    );
  } finally {
    await f.close();
  }
});

test('completed replacement remains authoritative after Queue live witness cleanup', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('completed replacement');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const stale = await f.reply(rootId, thread.id);
    const root = f.messages.getById(rootId)!;
    assert.ok(root.queueCustody);
    root.queueCustody = {
      ...root.queueCustody,
      status: 'terminal',
      pendingTargetCats: [],
      awakenedInvocationIdByCatId: {},
      steeredInvocationIdByCatId: {},
      seenInvocationIdByCatId: {},
      targetOutcomeByCatId: {
        codex: {
          invocationId: 'winning-child',
          disposition: 'completed',
          evidenceRef: { kind: 'turn_execution', invocationId: 'winning-child' },
          handledAt: Date.now(),
        },
      },
    };
    assert.notEqual((await f.deliver(stale.id)).kind, 'sent', 'terminal cleanup cannot revive the superseded child');
    const winning = await f.reply(rootId, thread.id);
    const winningOutcome = root.queueCustody.targetOutcomeByCatId?.codex;
    assert.ok(winningOutcome && winning.extra?.stream?.turnInvocationId);
    winningOutcome.invocationId = winning.extra.stream.turnInvocationId;
    assert.equal(
      (await f.deliver(winning.id)).kind,
      'sent',
      'the completed winning child can still deliver its final reply',
    );
  } finally {
    await f.close();
  }
});

test('ordinary mid-task callback speech stays visible but only a final publication auto-returns to dot', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('progress');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const progress = await f.reply(rootId, thread.id, 'codex', undefined, false, false);
    assert.equal(progress.extra?.isExplicitPost, true);
    assert.deepEqual(progress.mentions, [], 'ordinary progress must not wake dot');
    assert.ok(!f.queue.list(thread.id, 'owner').some((e) => e.targetCats.includes('gpt-dot')));
    const final = await f.reply(rootId, thread.id);
    assert.deepEqual(final.mentions, ['gpt-dot']);
    assert.equal((await f.deliver(final.id)).kind, 'sent');
    assert.equal(f.events.length, 1);
  } finally {
    await f.close();
  }
});

for (const failure of ['preflight rejection', 'enqueue exception'] as const) {
  test(`dot ask reports retryable ${failure} and recovers the same durable question`, async () => {
    let blocked = true;
    const f = await fixture(
      failure === 'preflight rejection'
        ? {
            routingDispatchPreflight: {
              preflight: async (input) => ({
                v: 1,
                ownerId: input.ownerId,
                observedAt: Date.now(),
                resolverState: 'fresh',
                targets: input.targetCatIds.map((targetCatId) => ({
                  targetCatId,
                  disposition: blocked ? 'rejected' : 'allowed',
                  reasons: [],
                  alternatives: [],
                })),
              }),
            },
          }
        : {},
    );
    const enqueue = f.queue.enqueue.bind(f.queue);
    if (failure === 'enqueue exception')
      f.queue.enqueue = (input) => {
        if (blocked) throw new Error('queue unavailable');
        return enqueue(input);
      };
    try {
      const thread = f.thread(failure);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.ask(thread.id);
        assert.equal(response.error?.data.reason, 'dot_ask_delivery_pending', JSON.stringify(response));
        assert.equal(f.postResults.at(-1)?.statusCode, 503);
        assert.equal(f.queue.list(thread.id, 'owner').length, 0);
      }
      const [initial, retry] = f.postResults;
      assert.ok(initial.body.messageId);
      assert.equal(retry.body.messageId, initial.body.messageId);
      assert.equal(f.messages.getById(initial.body.messageId)?.deliveryStatus, 'queued');
      const remote = await f.remote.rpc('tools/call', {
        name: 'cat_cafe_dot_ask',
        arguments: {
          attempt_id: f.setup.attemptId,
          thread_id: thread.id,
          target_cat_ids: ['codex'],
          content: '请回答这一问',
          client_message_id: 'request',
        },
      });
      assert.equal(remote.result.isError, true, 'the shared Remote must preserve the retryable error');
      assert.match(remote.result.content[0].text, /dot_ask_delivery_pending/);
      blocked = false;
      const recovered = await f.ask(thread.id);
      assert.equal(recovered.result.structuredContent.messageId, initial.body.messageId);
      assert.equal(f.queue.list(thread.id, 'owner').length, 1);
      assert.equal((await f.ask(thread.id)).result.structuredContent.messageId, initial.body.messageId);
      assert.equal(f.queue.list(thread.id, 'owner').length, 1, 'recovery must not create a second dispatch');
    } finally {
      await f.close();
    }
  });
}
