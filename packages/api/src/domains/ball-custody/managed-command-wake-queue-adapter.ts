import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import type { IInvocationRecordStore } from '../cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  type ManagedCommandWakeRecoveryDeps,
  resolveManagedCommandWakeEventCarrier,
} from './managed-command-wake-lifecycle.js';

interface ManagedCommandWakeQueueAdapterDeps {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  readonly invocationQueue: Pick<InvocationQueue, 'getDurableEntriesForMessages'>;
}

export function createManagedCommandWakeQueueAdapter(
  deps: ManagedCommandWakeQueueAdapterDeps,
): Pick<ManagedCommandWakeRecoveryDeps, 'getEventCarrier'> {
  return {
    getEventCarrier: async ({ threadId, userId, catId, messageId }) => {
      const message = await deps.messageStore.getById(messageId);
      const rows = (await deps.invocationQueue.getDurableEntriesForMessages(threadId, [messageId])).get(messageId);
      const entry = rows?.find(
        (candidate) =>
          candidate.owner.kind === 'user' &&
          candidate.owner.userId === userId &&
          candidate.target.kind === 'cat' &&
          candidate.target.catId === catId,
      );
      const carrier = resolveManagedCommandWakeEventCarrier(message, entry, { threadId, catId });
      if (carrier.state !== 'failed' || !carrier.invocationId) return carrier;
      const invocation = await deps.invocationRecordStore.get(carrier.invocationId);
      return {
        ...carrier,
        ...(invocation?.status === 'failed' && invocation.error ? { errorCode: invocation.error } : {}),
      };
    },
  };
}
