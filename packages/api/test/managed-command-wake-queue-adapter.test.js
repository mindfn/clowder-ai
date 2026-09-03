import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createManagedCommandWakeQueueAdapter } from '../dist/domains/ball-custody/managed-command-wake-queue-adapter.js';

function terminalEntry(overrides = {}) {
  return {
    version: 1,
    id: 'queue:managed-wake',
    threadId: 'thread-managed-adapter',
    owner: { kind: 'user', userId: 'user-owner' },
    kind: 'conversation_input',
    from: { kind: 'system', service: 'scheduler' },
    target: { kind: 'cat', catId: 'codex-sol' },
    payload: { sourceId: 'message-managed-wake', messageId: 'message-managed-wake', content: 'command complete' },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: true },
    delivery: {
      attemptId: 'queue:managed-wake:1',
      seenInvocationId: 'invocation-failed',
      terminalOutcome: 'failed',
      failedAt: 300,
      failureReason: 'invocation_failed',
    },
    status: 'terminal',
    enqueuedAt: 100,
    processingStartedAt: 200,
    terminalAt: 300,
    priority: 'normal',
    ...overrides,
  };
}

describe('managed command wake durable-ledger adapter', () => {
  it('projects one exact terminal failure with provider evidence', async () => {
    const entry = terminalEntry();
    const adapter = createManagedCommandWakeQueueAdapter({
      messageStore: {
        getById: async (id) =>
          id === 'message-managed-wake' ? { id, threadId: entry.threadId, deliveryStatus: 'delivered' } : null,
      },
      invocationRecordStore: {
        get: async (id) =>
          id === 'invocation-failed' ? { id, status: 'failed', error: 'managed_hold_disposition_missing' } : null,
      },
      invocationQueue: {
        getDurableEntriesForMessages: async () => new Map([['message-managed-wake', [entry]]]),
      },
    });

    assert.deepEqual(
      await adapter.getEventCarrier({
        threadId: entry.threadId,
        userId: 'user-owner',
        catId: 'codex-sol',
        messageId: 'message-managed-wake',
      }),
      {
        state: 'failed',
        attemptId: 'queue:managed-wake:1',
        attemptSequence: 1,
        invocationId: 'invocation-failed',
        errorCode: 'managed_hold_disposition_missing',
      },
    );
  });

  it('does not expose a carrier across its durable owner boundary', async () => {
    const entry = terminalEntry();
    const adapter = createManagedCommandWakeQueueAdapter({
      messageStore: { getById: async () => ({ id: 'message-managed-wake', threadId: entry.threadId }) },
      invocationRecordStore: { get: async () => null },
      invocationQueue: {
        getDurableEntriesForMessages: async () => new Map([['message-managed-wake', [entry]]]),
      },
    });

    assert.deepEqual(
      await adapter.getEventCarrier({
        threadId: entry.threadId,
        userId: 'user-foreign',
        catId: 'codex-sol',
        messageId: 'message-managed-wake',
      }),
      { state: 'missing' },
    );
  });
});
