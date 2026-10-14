import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

export function makeQueueCancellationFixture(admittedCats = ['codex'], requestedCats = ['codex', 'opus']) {
  const store = new MessageStore();
  const queue = new InvocationQueue();
  const message = store.append({
    id: 'cancel-source',
    threadId: 't1',
    userId: 'user-a',
    catId: 'opus',
    content: 'retain the original cancelled notification',
    mentions: requestedCats,
    timestamp: 100,
    deliveryStatus: 'queued',
  });
  const entries = admittedCats.map(
    (catId) =>
      queue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: message.threadId,
        userId: message.userId,
        messageId: message.id,
        content: message.content,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
        a2aTriggerMessageId: message.id,
      }).entry,
  );
  store.initializeQueueCustody(
    message.id,
    createInitialCrossThreadQueuedMessageCustody(message.id, entries, {
      requestedTargetCats: requestedCats,
      createdAt: 100,
    }),
  );
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => Date.now() });
  return { store, queue, message, entries, coordinator };
}
