import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { CloudAssistantReturnIngestService } from '../src/domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js';
import { MemoryCloudReturnGrantStore } from '../src/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { PersonalChromeAssistantReturnPoller } from '../src/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-assistant-return-poller.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';

const pending = {
  conversationId: 'conversation-7',
  sourceMessageId: 'source-message-9',
  assistantMessageId: 'conversation-turn-43',
  content: 'bounded assistant final',
};

describe('PersonalChromeAssistantReturnPoller', () => {
  it('retains transient failures and acknowledges only after the exact source persists', async () => {
    const acknowledgements: Array<[string, string, string]> = [];
    const outcomes = [
      { status: 'retry', reason: 'append_failed' } as const,
      { status: 'persisted', messageId: 'callback-message-1' } as const,
    ];
    const ingested = [];
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async () => [pending],
        ack_assistant_return: async (conversationId, sourceMessageId, assistantMessageId) => {
          acknowledgements.push([conversationId, sourceMessageId, assistantMessageId]);
        },
      },
      ingestService: {
        ingest: async (input) => {
          ingested.push(input);
          return outcomes.shift() ?? { status: 'duplicate', messageId: 'callback-message-1' };
        },
      },
      logger: { warn() {} },
      grantPersistence: 'durable',
    });

    await poller.drainOnce();
    assert.deepEqual(acknowledgements, []);
    await poller.drainOnce();

    assert.deepEqual(ingested, [
      { sourceMessageId: pending.sourceMessageId, content: pending.content },
      { sourceMessageId: pending.sourceMessageId, content: pending.content },
    ]);
    assert.deepEqual(acknowledgements, [[pending.conversationId, pending.sourceMessageId, pending.assistantMessageId]]);
  });

  it('acknowledges a permanently rejected forged return after recording the exact reason', async () => {
    const warnings: Array<{ context: object; message: string }> = [];
    let acknowledged = false;
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async () => [pending],
        ack_assistant_return: async () => {
          acknowledged = true;
        },
      },
      ingestService: { ingest: async () => ({ status: 'rejected', reason: 'source_ineligible' }) },
      logger: { warn: (context, message) => warnings.push({ context, message }) },
      grantPersistence: 'durable',
    });

    await poller.drainOnce();

    assert.equal(acknowledged, true);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0].context, {
      conversationId: pending.conversationId,
      sourceMessageId: pending.sourceMessageId,
      assistantMessageId: pending.assistantMessageId,
      reason: 'source_ineligible',
    });
  });

  it('acknowledges a missing grant when the durable grant store proves it is terminal', async () => {
    let acknowledged = false;
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async () => [pending],
        ack_assistant_return: async () => {
          acknowledged = true;
        },
      },
      ingestService: { ingest: async () => ({ status: 'rejected', reason: 'grant_not_found' }) },
      logger: { warn() {} },
      grantPersistence: 'durable',
    });

    await poller.drainOnce();

    assert.equal(acknowledged, true);
  });

  it('retains a no-Redis restart return without head-blocking newer authorized returns', async () => {
    const messageStore = new MessageStore();
    const source = messageStore.append({
      userId: 'alice',
      catId: createCatId('codex-sol'),
      threadId: 'thread-f247-restart-return',
      content: '@gpt-pro recover this exact source after restart',
      mentions: [createCatId('gpt-pro')],
      timestamp: 1_000,
    });
    const newerSource = messageStore.append({
      userId: 'alice',
      catId: createCatId('codex-sol'),
      threadId: source.threadId,
      content: '@gpt-pro accept this newer source while the restart return remains recoverable',
      mentions: [createCatId('gpt-pro')],
      timestamp: 2_000,
    });
    const scope = {
      threadId: source.threadId,
      userId: source.userId,
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    const grantStoreBeforeRestart = new MemoryCloudReturnGrantStore();
    await grantStoreBeforeRestart.issue({ ...scope, dispatchInvocationId: 'dispatch-before-restart' });

    // REDIS_URL is absent: API restart constructs a fresh in-memory store while
    // the Native Host keeps the exact assistant final in its durable inbox.
    const grantStoreAfterRestart = new MemoryCloudReturnGrantStore();
    await grantStoreAfterRestart.issue({
      threadId: newerSource.threadId,
      userId: newerSource.userId,
      sourceMessageId: newerSource.id,
      targetCatId: 'gpt-pro',
      dispatchInvocationId: 'dispatch-newer-after-restart',
    });
    const acknowledgements: Array<[string, string, string]> = [];
    const restartPending = { ...pending, sourceMessageId: source.id };
    const newerPending = {
      ...pending,
      sourceMessageId: newerSource.id,
      assistantMessageId: 'conversation-turn-44',
      content: 'newer bounded assistant final',
    };
    type ReturnCursor = {
      readonly conversationId: string;
      readonly sourceMessageId: string;
      readonly assistantMessageId: string;
    };
    const listCursors: Array<ReturnCursor | undefined> = [];
    const adapter = {
      list_assistant_returns: async (after?: ReturnCursor) => {
        listCursors.push(after);
        if (!after) return [restartPending];
        if (
          after.conversationId === restartPending.conversationId &&
          after.sourceMessageId === restartPending.sourceMessageId &&
          after.assistantMessageId === restartPending.assistantMessageId
        ) {
          return [newerPending];
        }
        return [];
      },
      ack_assistant_return: async (conversationId: string, sourceMessageId: string, assistantMessageId: string) => {
        acknowledgements.push([conversationId, sourceMessageId, assistantMessageId]);
      },
    };
    const ingestService = new CloudAssistantReturnIngestService({
      messageStore,
      grantStore: grantStoreAfterRestart,
      socketManager: { broadcastAgentMessage() {} },
      logger: { error() {}, warn() {} },
    });
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter,
      ingestService,
      logger: { warn() {} },
      grantPersistence: 'ephemeral',
    });

    await poller.drainOnce();

    assert.deepEqual(acknowledgements, [], 'missing ephemeral grant must not delete the durable Host return');
    assert.equal(
      (await messageStore.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length,
      0,
    );

    await poller.drainOnce();

    assert.deepEqual(acknowledgements, [
      [newerPending.conversationId, newerPending.sourceMessageId, newerPending.assistantMessageId],
    ]);
    assert.equal(
      (await messageStore.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length,
      1,
    );

    await grantStoreAfterRestart.issue({ ...scope, dispatchInvocationId: 'dispatch-after-restart' });
    await poller.drainOnce();

    assert.deepEqual(acknowledgements, [
      [newerPending.conversationId, newerPending.sourceMessageId, newerPending.assistantMessageId],
      [restartPending.conversationId, restartPending.sourceMessageId, restartPending.assistantMessageId],
    ]);
    assert.deepEqual(listCursors, [
      undefined,
      {
        conversationId: restartPending.conversationId,
        sourceMessageId: restartPending.sourceMessageId,
        assistantMessageId: restartPending.assistantMessageId,
      },
      undefined,
    ]);
    assert.equal(
      (await messageStore.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length,
      2,
    );
  });

  it('advances past two retained colliding returns to a later authorized return', async () => {
    const retained = { ...pending, assistantMessageId: 'conversation-turn-2' };
    const moved = {
      ...retained,
      conversationId: 'conversation-8',
      content: 'retained final after the route moved',
    };
    const later = {
      ...pending,
      conversationId: 'conversation-9',
      sourceMessageId: 'source-message-10',
      assistantMessageId: 'conversation-turn-3',
      content: 'later authorized final',
    };
    type ReturnCursor = {
      readonly conversationId: string;
      readonly sourceMessageId: string;
      readonly assistantMessageId: string;
    };
    const listCursors: Array<ReturnCursor | undefined> = [];
    const acknowledgements: Array<[string, string, string]> = [];
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async (after?: ReturnCursor) => {
          listCursors.push(after);
          if (!after) return [retained];
          if (after.conversationId === retained.conversationId) return [moved];
          if (after.conversationId === moved.conversationId) return [later];
          return [];
        },
        ack_assistant_return: async (conversationId, sourceMessageId, assistantMessageId) => {
          acknowledgements.push([conversationId, sourceMessageId, assistantMessageId]);
        },
      },
      ingestService: {
        ingest: async ({ sourceMessageId }) =>
          sourceMessageId === later.sourceMessageId
            ? { status: 'persisted', messageId: 'callback-message-later' }
            : { status: 'rejected', reason: 'grant_not_found' },
      },
      logger: { warn() {} },
      grantPersistence: 'ephemeral',
    });

    await poller.drainOnce();
    await poller.drainOnce();
    await poller.drainOnce();

    assert.deepEqual(listCursors, [
      undefined,
      {
        conversationId: retained.conversationId,
        sourceMessageId: retained.sourceMessageId,
        assistantMessageId: retained.assistantMessageId,
      },
      {
        conversationId: moved.conversationId,
        sourceMessageId: moved.sourceMessageId,
        assistantMessageId: moved.assistantMessageId,
      },
    ]);
    assert.deepEqual(acknowledgements, [[later.conversationId, later.sourceMessageId, later.assistantMessageId]]);
  });

  it('wraps a retained ephemeral return back to the head after reaching the inbox tail', async () => {
    const listCursors: Array<
      | {
          readonly conversationId: string;
          readonly sourceMessageId: string;
          readonly assistantMessageId: string;
        }
      | undefined
    > = [];
    const outcomes = [
      { status: 'rejected', reason: 'grant_not_found' } as const,
      { status: 'persisted', messageId: 'callback-message-after-grant-reissue' } as const,
    ];
    let acknowledged = false;
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async (after) => {
          listCursors.push(after);
          return after ? [] : [pending];
        },
        ack_assistant_return: async () => {
          acknowledged = true;
        },
      },
      ingestService: {
        ingest: async () =>
          outcomes.shift() ?? { status: 'duplicate', messageId: 'callback-message-after-grant-reissue' },
      },
      logger: { warn() {} },
      grantPersistence: 'ephemeral',
    });

    await poller.drainOnce();
    await poller.drainOnce();
    await poller.drainOnce();

    assert.equal(acknowledged, true);
    assert.deepEqual(listCursors, [
      undefined,
      {
        conversationId: pending.conversationId,
        sourceMessageId: pending.sourceMessageId,
        assistantMessageId: pending.assistantMessageId,
      },
      undefined,
    ]);
  });
});

describe('PersonalChromeAssistantReturnPoller when the Host Adapter is unavailable', () => {
  function unavailable() {
    return Object.assign(new Error('personal Chrome Host Adapter is not installed'), { code: 'HOST_UNAVAILABLE' });
  }

  function harness(options: { failures: number }) {
    let clock = 0;
    let remainingFailures = options.failures;
    const calls: number[] = [];
    const logs: string[] = [];
    const poller = new PersonalChromeAssistantReturnPoller({
      adapter: {
        list_assistant_returns: async () => {
          calls.push(clock);
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            throw unavailable();
          }
          return [];
        },
        ack_assistant_return: async () => {},
      },
      ingestService: { ingest: async () => ({ status: 'duplicate', messageId: 'unused' }) },
      logger: {
        debug: (_context, message) => logs.push(message),
        warn: (_context, message) => logs.push(message),
      },
      grantPersistence: 'durable',
      now: () => clock,
    });
    return {
      calls,
      logs,
      async tickUntil(untilMs: number) {
        for (; clock <= untilMs; clock += 1_000) await poller.drainOnce();
        clock -= 1_000;
      },
    };
  }

  it('backs off to one check a minute and logs the state change once, not every second', async () => {
    const h = harness({ failures: Number.POSITIVE_INFINITY });

    await h.tickUntil(180_000);

    // 2s, 4s, 8s, 16s, 32s, then capped at 60s: a handful of checks, not one per second.
    assert.deepEqual(h.calls, [0, 2_000, 6_000, 14_000, 30_000, 62_000, 122_000]);
    assert.equal(h.logs.length, 1, `one line when polling backs off, got ${JSON.stringify(h.logs)}`);
    assert.match(h.logs[0], /unavailable/);
  });

  it('resumes the normal cadence as soon as the adapter answers, with one line', async () => {
    const h = harness({ failures: 3 });

    await h.tickUntil(20_000);

    // Fails at 0, 2s, 6s; answers at 14s, then polls every second again.
    assert.deepEqual(h.calls.slice(0, 5), [0, 2_000, 6_000, 14_000, 15_000]);
    assert.equal(h.calls.at(-1), 20_000);
    assert.equal(h.logs.length, 2, `one line to back off, one to resume, got ${JSON.stringify(h.logs)}`);
    assert.match(h.logs[1], /resumed/);
  });
});
