import { isDeepStrictEqual } from 'node:util';
import type { ContentModificationRecord } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { TurnExecutionSourceReadPort } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import { type MediaPublicationReturnIntent, mediaPublicationProjection } from './media-publication-return.js';
import { readModificationSourceExecution } from './source-execution.js';

/** Exact durable source causality identifies the consumer; live actions additionally require it to be running. */
export async function witnessedPublicationCaller(
  deps: { messages: Pick<IMessageStore, 'getById'>; turns?: TurnExecutionSourceReadPort },
  intent: MediaPublicationReturnIntent,
  invocationId?: string,
  requiredCarrierStatus?: 'terminal',
) {
  if (!deps.turns || intent.state !== 'queued' || !intent.messageId) return;
  const carrier = await deps.messages.getById(intent.messageId);
  const child = carrier
    ? await readModificationSourceExecution(deps.messages, deps.turns, carrier, intent.targetCatId, invocationId)
    : undefined;
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
    child?.userId === intent.ownerUserId &&
    child.threadId === intent.threadId &&
    child.catId === intent.targetCatId &&
    (!requiredCarrierStatus || ['succeeded', 'failed', 'canceled'].includes(child.status)) &&
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
