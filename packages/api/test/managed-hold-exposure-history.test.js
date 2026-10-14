import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveThreadMessageVisibility } from '../dist/domains/cats/services/stores/visibility.js';
import { makeQueuedMessageCustody } from './helpers/queued-message-custody.js';

function exposedWake() {
  return {
    id: 'previous-wake',
    userId: 'scheduler',
    catId: null,
    threadId: 'thread-managed-owner',
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      meta: { taskId: 'previous-task', threadId: 'thread-managed-owner', catId: 'opus', wakeWhen: true },
    },
    queueCustody: makeQueuedMessageCustody({
      entryId: 'failed-carrier',
      ownerUserId: 'user-1',
      allTargetCats: ['opus'],
      pendingTargetCats: ['opus'],
      failedByCatIds: ['opus'],
      bodyExposures: [{ targetCatId: 'opus', invocationId: 'previous-child', seenAt: 1350 }],
    }),
  };
}

const historyOptions = { includeExposedQueuedUserMessagesForCatId: 'opus' };

test('managed wake history retains an exposed failed child body for its exact owner and target', () => {
  assert.equal(resolveThreadMessageVisibility(historyOptions, 'user-1')(exposedWake()), true);
});

test('managed wake history preserves owner, target, hidden-trigger and source boundaries', () => {
  const source = exposedWake();
  assert.equal(resolveThreadMessageVisibility(historyOptions, 'other-owner')(source), false);
  assert.equal(
    resolveThreadMessageVisibility({ includeExposedQueuedUserMessagesForCatId: 'codex' }, 'user-1')(source),
    false,
  );
  const ownerHistory = resolveThreadMessageVisibility(historyOptions, 'user-1');
  assert.equal(ownerHistory({ ...source, extra: { scheduler: { hiddenTrigger: true } } }), false);
  assert.equal(ownerHistory({ ...source, queueCustody: { ...source.queueCustody, bodyExposures: [] } }), false);
  assert.equal(
    ownerHistory({ ...source, source: { ...source.source, meta: { ...source.source.meta, threadId: 'foreign' } } }),
    false,
  );
});
