import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';

test('Live inbox wakes after atomic Message and Queue admission, never before the body exists', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const signals: string[] = [];
  queue.onSourceChanged((threadId, userId) => {
    const [entry] = queue.list(threadId, userId);
    assert.ok(entry.payload.messageId);
    assert.equal(messages.getById(entry.payload.messageId)?.content, 'body');
    signals.push(`${threadId}:${userId}`);
  });
  let release!: () => void;
  let entered!: () => void;
  const committing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = messages.appendWithQueueLedgerAdmission.bind(messages);
  messages.appendWithQueueLedgerAdmission = async (...args) => {
    entered();
    await barrier;
    return commit(...args);
  };
  const from = { kind: 'agent' as const, catId: 'opus' };
  const admission = queue.send(
    messages,
    {
      userId: 'owner',
      threadId: 'home',
      from,
      content: 'body',
      mentions: [],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      kind: 'conversation_input',
      userId: 'owner',
      threadId: 'home',
      from,
      content: 'body',
      targetCats: ['codex-astra'],
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    },
  );
  await committing;
  assert.deepEqual(signals, []);
  assert.equal(messages.getByThread('home', 10, 'owner').length, 0);
  release();
  const accepted = await admission;
  assert.ok(accepted.message && accepted.entry);
  assert.equal((await queue.getDurableEntry('home', accepted.entry.id))?.payload.messageId, accepted.message.id);
  assert.deepEqual(signals, ['home:owner']);
});
