import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { isUserFacingSystemInfoContent } from '../dist/domains/cats/services/agents/routing/route-helpers.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function lifecycle(status, overrides = {}) {
  return JSON.stringify({
    type: 'session_rollover_lifecycle',
    v: 1,
    rolloverId: 'inv-oversized-1:codex-native-resume',
    status,
    reason: 'oversized_retire',
    ...overrides,
  });
}

async function persistedLifecycleMessages(store, contents) {
  await persistUserFacingSystemInfoNotices({
    messageStore: store,
    threadId: 'thread-owner',
    catId: 'codex-sol',
    contents,
  });
  return (await store.getByThread('thread-owner')).filter(
    (message) => message.source?.connector === 'session-rollover-lifecycle',
  );
}

describe('F296 oversized native rollover response-owned diagnostics', () => {
  it('keeps lifecycle stages out of History because the response bubble owns execution status', async () => {
    const store = new MessageStore();
    const pending = lifecycle('pending');
    const succeeded = lifecycle('succeeded');

    assert.equal(isUserFacingSystemInfoContent(pending), true);
    const messages = await persistedLifecycleMessages(store, [pending, pending, succeeded, succeeded]);

    assert.equal(messages.length, 0);
  });

  it('does not append a second system row for a failed response-owned rollover', async () => {
    const store = new MessageStore();
    const failed = lifecycle('failed', { failureStage: 'seal_finalize' });
    const messages = await persistedLifecycleMessages(store, [
      lifecycle('failed'),
      lifecycle('succeeded', { reason: 'invented_reason' }),
      lifecycle('pending', { rolloverId: '' }),
      lifecycle('pending', { v: 2 }),
      failed,
      failed,
    ]);

    assert.equal(messages.length, 0);
  });
});
