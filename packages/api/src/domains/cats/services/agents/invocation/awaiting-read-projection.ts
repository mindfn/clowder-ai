import type { LifecycleActiveRun, QueueAwaitingReadInput } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { AgentClientActiveRunDispatcher } from '../../types.js';

export interface AwaitingReadTracker {
  getActiveSlots?(threadId: string): Array<{ catId: string; activeRun?: LifecycleActiveRun }>;
  getAgentClientActiveRunDispatcher?(threadId: string, catId: string): AgentClientActiveRunDispatcher | undefined;
}

/**
 * F117 Phase M: the Queue Panel's "等待读取 → cat" rows, projected from History. The input's waiting
 * dispatchRef is canonical and the response's handed index finds it. A row is shown only while the
 * carrier that holds the input is still open, so a run that ended never leaves a stale row: its
 * inputs are published unread instead.
 */
export async function projectAwaitingReadInputs(input: {
  threadId: string;
  userId: string;
  invocationTracker: AwaitingReadTracker;
  messageStore: Pick<IMessageStore, 'getById'>;
}): Promise<QueueAwaitingReadInput[]> {
  const rows: QueueAwaitingReadInput[] = [];
  for (const slot of input.invocationTracker.getActiveSlots?.(input.threadId) ?? []) {
    const run = slot.activeRun;
    if (!run) continue;
    const dispatcher = input.invocationTracker.getAgentClientActiveRunDispatcher?.(input.threadId, slot.catId);
    if (dispatcher?.invocationId !== run.invocationId) continue;
    const response = await input.messageStore.getById(run.responseMessageId);
    const lifecycle = response?.lifecycle;
    if (
      !response ||
      lifecycle?.kind !== 'response' ||
      lifecycle.status !== 'processing' ||
      lifecycle.invocationId !== run.invocationId
    ) {
      continue;
    }
    for (const messageId of lifecycle.handedInputMessageIds ?? []) {
      const source = await input.messageStore.getById(messageId);
      if (!source || source.threadId !== input.threadId || source.userId !== input.userId) continue;
      const ref = source.lifecycle?.dispatchRefs?.find(
        (candidate) => candidate.targetId === lifecycle.targetId && candidate.statusMessageId === response.id,
      );
      if (ref?.phase !== 'dispatched' || ref.readState !== 'awaiting') continue;
      rows.push({
        messageId,
        targetId: lifecycle.targetId,
        responseMessageId: response.id,
        handedAt: ref.dispatchedAt ?? source.timestamp,
        from: messageFrom(source),
        content: source.content,
        ...(source.contentBlocks?.length ? { contentBlocks: source.contentBlocks } : {}),
      });
    }
  }
  return rows.sort((left, right) => left.handedAt - right.handedAt || left.messageId.localeCompare(right.messageId));
}
