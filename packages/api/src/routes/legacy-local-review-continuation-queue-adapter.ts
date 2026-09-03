import { createCatId } from '@cat-cafe/shared';
import type { LegacyLocalReviewDispositionServiceDeps } from '../domains/ball-custody/LegacyLocalReviewDispositionService.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { QueueProcessorLike } from './callback-a2a-trigger.js';

export interface LegacyLocalReviewContinuationQueueDeps {
  invocationQueue: InvocationQueue;
  messageStore: IMessageStore;
  queueProcessor?: QueueProcessorLike;
}

export function createLegacyLocalReviewContinuationQueueAdapter(
  deps: LegacyLocalReviewContinuationQueueDeps,
): LegacyLocalReviewDispositionServiceDeps['enqueueContinuation'] {
  const { invocationQueue } = deps;
  return async ({ decisionMessage, predecessorCatId, predecessorThreadId }) => {
    const existingCarrier = invocationQueue.findEntryWithMessageId(predecessorThreadId, decisionMessage.id);
    if (existingCarrier) return { outcome: 'replayed', queueEntryId: existingCarrier.id };

    const persistedRows =
      (await invocationQueue.getDurableEntriesForMessages(predecessorThreadId, [decisionMessage.id])).get(
        decisionMessage.id,
      ) ?? [];
    if (persistedRows.length > 0) {
      return {
        outcome: 'replayed',
        queueEntryId: persistedRows[0]!.id,
      };
    }

    const targetCatId = createCatId(predecessorCatId);
    const result = await invocationQueue.enqueueExistingMessageDurable(deps.messageStore, decisionMessage.id, {
      from: messageFrom(decisionMessage),
      threadId: predecessorThreadId,
      userId: decisionMessage.userId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: decisionMessage.content,
      messageId: decisionMessage.id,
      sourceId: decisionMessage.id,
      sourceCategory: 'continuation',
      targetCats: [targetCatId],
      intent: 'execute',
      autoExecute: true,
    });
    if (result.outcome === 'full' || !result.entry) {
      throw new Error('legacy review continuation has no durable Queue carrier');
    }
    await deps.queueProcessor?.requestDrain?.(predecessorThreadId);
    return {
      outcome: result.deduped ? 'replayed' : 'enqueued',
      queueEntryId: result.entry.id,
    };
  };
}
