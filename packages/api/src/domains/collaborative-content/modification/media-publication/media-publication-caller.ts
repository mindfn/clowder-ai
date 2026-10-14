import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../../../cats/services/stores/ports/queued-message-receipt.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import { type MediaPublicationReturnIntent, mediaPublicationProjection } from './media-publication-return.js';

/** Durable body exposure identifies the return consumer. Live actions additionally require it to be running. */
export async function witnessedPublicationCaller(
  deps: { messages: Pick<IMessageStore, 'getById'>; turns?: Pick<ITurnExecutionStore, 'get'> },
  intent: MediaPublicationReturnIntent,
  invocationId?: string,
  requiredCarrierStatus?: 'terminal',
) {
  if (!deps.turns || intent.state !== 'queued' || !intent.messageId) return;
  const carrier = await deps.messages.getById(intent.messageId);
  const latest = carrier?.queueCustody
    ? projectQueueReceipt(carrier.queueCustody)
        .targets.find((item) => item.catId === intent.targetCatId)
        ?.attempts?.at(-1)
    : undefined;
  const callerId = invocationId ?? latest?.invocationId;
  const child = callerId ? await deps.turns.get(callerId) : null;
  if (
    carrier &&
    !carrier.recall &&
    !carrier.deletedAt &&
    !carrier._tombstone &&
    carrier.userId === intent.ownerUserId &&
    carrier.threadId === intent.threadId &&
    isDeepStrictEqual(carrier.source, mediaPublicationProjection(intent).source) &&
    sameAudience(
      carrier,
      intent.visibility === 'whisper'
        ? { visibility: 'whisper', whisperTo: intent.whisperTo ?? [] }
        : { visibility: 'public' },
    ) &&
    carrier.queueCustody?.ownerUserId === intent.ownerUserId &&
    (!requiredCarrierStatus ||
      (carrier.queueCustody.status === requiredCarrierStatus &&
        !carrier.queueCustody.pendingTargetCats.some((catId) => catId === intent.targetCatId))) &&
    latest?.invocationId === callerId &&
    carrier.queueCustody.bodyExposures?.some(
      (item) => item.targetCatId === intent.targetCatId && item.invocationId === callerId,
    ) &&
    child?.userId === intent.ownerUserId &&
    child.threadId === intent.threadId &&
    child.catId === intent.targetCatId &&
    (child.causal?.triggerMessageId === carrier.id || child.causal?.coveredMessageIds?.includes(carrier.id))
  )
    return child;
}

export function sameAudience(
  message: StoredMessage,
  audience: ContentModificationRecord['progress']['sourceVisibility'],
) {
  if (audience?.visibility !== 'whisper') return message.visibility !== 'whisper';
  return (
    message.visibility === 'whisper' &&
    isDeepStrictEqual([...(message.whisperTo ?? [])].sort(), [...audience.whisperTo].sort())
  );
}
