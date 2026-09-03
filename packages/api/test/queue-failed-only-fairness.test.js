import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

function queueInput(sourceId, overrides = {}) {
  return {
    threadId: 'thread-fairness',
    userId: 'user-owner',
    sourceId,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: `body-${sourceId}`,
    messageId: `message-${sourceId}`,
    from: { kind: 'user', userId: 'user-owner' },
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  };
}

async function terminalizeFailed(queue, entry, reason = 'invocation_failed') {
  const claimed = await queue.markProcessingDurable(entry.threadId, 'user-owner', {
    entryId: entry.id,
    targetCats: [entry.target.catId],
  });
  assert.ok(claimed);
  assert.equal(await queue.commitClaimedProcessing(entry.threadId, [entry.id], 2_000), true);
  assert.ok(await queue.removeProcessedAcrossUsersDurable(entry.threadId, entry.id, 'failed', reason, 3_000));
}

describe('#1371 terminal-failure fairness over ADR-043 ledger', () => {
  it('a failed terminal row cannot block a later independent admission', async () => {
    const queue = new InvocationQueue();
    const failed = await queue.enqueueDurable(queueInput('failed-first'));
    await terminalizeFailed(queue, failed.entry);

    const later = await queue.enqueueDurable(
      queueInput('later-a2a', {
        from: { kind: 'agent', catId: 'codex' },
        sourceCategory: 'a2a',
        targetCats: ['codex'],
        autoExecute: true,
      }),
    );
    const claimed = await queue.markProcessingDurable('thread-fairness', 'user-owner', {
      entryId: later.entry.id,
      targetCats: ['codex'],
    });

    assert.equal(claimed?.id, later.entry.id);
    assert.deepEqual(
      queue.list('thread-fairness', 'user-owner').map((entry) => entry.id),
      [later.entry.id],
    );
    assert.equal((await queue.getDurableEntry('thread-fairness', failed.entry.id)).status, 'terminal');
  });

  it('terminalizing one fan-out target preserves the queued sibling', async () => {
    const queue = new InvocationQueue();
    const fanout = await queue.enqueueDurable(queueInput('fanout', { targetCats: ['opus', 'gemini'] }));
    const opus = fanout.entries.find((entry) => entry.target.kind === 'cat' && entry.target.catId === 'opus');
    const gemini = fanout.entries.find((entry) => entry.target.kind === 'cat' && entry.target.catId === 'gemini');
    assert.ok(opus);
    assert.ok(gemini);

    await terminalizeFailed(queue, opus, 'provider_failed');

    assert.equal(queue.getEntrySnapshot('thread-fairness', 'user-owner', gemini.id).status, 'queued');
    const claimed = await queue.markProcessingDurable('thread-fairness', 'user-owner', {
      entryId: gemini.id,
      targetCats: ['gemini'],
    });
    assert.equal(claimed?.id, gemini.id);
  });

  it('replaying the same source never reopens its failed terminal target', async () => {
    const queue = new InvocationQueue();
    const input = queueInput('terminal-replay');
    const first = await queue.enqueueDurable(input);
    await terminalizeFailed(queue, first.entry);

    const replay = await queue.enqueueDurable(input);
    assert.equal(replay.deduped, true);
    assert.deepEqual(replay.entries, []);
    const terminal = await queue.getDurableEntry('thread-fairness', first.entry.id);
    assert.equal(terminal.id, first.entry.id);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.delivery.terminalOutcome, 'failed');
    assert.equal(queue.list('thread-fairness', 'user-owner').length, 0);
  });
});
