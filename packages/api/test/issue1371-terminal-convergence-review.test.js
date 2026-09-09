import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHandedCvoEvent, buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { createA2ADispositionAuth, createA2ADispositionHarness } from './helpers/a2a-dispatch-disposition-harness.js';
import { runTerminalQueueHarness } from './helpers/issue1371-terminal-queue-harness.js';

for (const intent of ['done_notify', 'handoff']) {
  test(`#1371: exact dispatch can retire after unrelated thread ${intent}`, async () => {
    const h = await createA2ADispositionHarness();
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        messageId: 'unrelated-cvo-message',
        intent,
        at: 1_500,
      }),
    );
    const before = await h.projectionStore.get('ball:thread:thread-1');
    const result = await h.service.complete(createA2ADispositionAuth(h), 'completed');
    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, true);
    const after = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(after.state, before.state, 'exact retirement cannot alter unrelated thread state');
    assert.equal(after.holder, before.holder);
  });
}

test('#1371: a newer unrelated dispatch to the same cat keeps its active thread projection', async () => {
  const h = await createA2ADispositionHarness();
  const unrelated = h.messageStore.append({
    userId: 'user-1',
    from: { kind: 'agent', catId: 'opus' },
    content: 'Independent task',
    mentions: ['codex-sol'],
    timestamp: 1_500,
    threadId: 'thread-1',
  });
  await h.ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: 'opus',
      toCatId: 'codex-sol',
      messageId: unrelated.id,
      at: 1_500,
    }),
  );
  const result = await h.service.complete(createA2ADispositionAuth(h), 'completed');
  assert.equal(result.retired, true);
  assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'active');
});

// Real dispatch service, projector, message custody coordinator and QueueProcessor.
// The provider is the only execution stub; it persists a source-bound reply.
for (const scenario of ['active control', 'done_notify', 'retirement unavailable', 'restart after success']) {
  test(`#1371: replied cross-thread terminal has no live carrier (${scenario})`, async () => {
    const { h, terminal, source, response, queue, deps, result } = await runTerminalQueueHarness(scenario);
    assert.equal(result.status, 'succeeded');
    assert.equal(queue.list(terminal.threadId, terminal.userId).length, 0);
    assert.equal(source.deliveryStatus, undefined, 'public Agent speech remains visible in History');
    assert.equal(source.lifecycle.kind, 'input');
    assert.deepEqual(source.lifecycle.dispatchRefs, [
      {
        targetId: 'fable5',
        phase: 'settled',
        statusMessageId: response.id,
        dispatchedAt: 1_760,
      },
    ]);
    assert.equal(response.lifecycle.kind, 'response');
    assert.equal(response.lifecycle.status, 'completed');
    assert.equal(response.replyTo, terminal.id);
    assert.equal(deps.router.routeExecution.mock.calls.length, 1);
    if (scenario === 'restart after success') {
      await assert.rejects(
        () =>
          queue.enqueueExistingMessageDurable(h.messageStore, terminal.id, {
            from: terminal.from,
            threadId: terminal.threadId,
            userId: terminal.userId,
            kind: 'message_wake',
            ownerAuthProvenance: 'unknown',
            content: terminal.content,
            messageId: terminal.id,
            sourceId: terminal.id,
            sourceCategory: 'a2a',
            targetCats: ['fable5'],
            intent: 'execute',
            autoExecute: true,
          }),
        /already dispatched source target/,
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'settled source cannot run the provider again');
    }
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      scenario === 'retirement unavailable' ? 0 : 1,
    );
  });
}
