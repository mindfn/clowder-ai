import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type ConnectorSource,
  type ContentModificationRecord,
  type ContentModificationRequestView,
  contentModificationRequestCarrierV1Schema,
} from '@cat-cafe/shared';
import { carrierEntryId } from '../../cats/services/agents/invocation/QueuedMessageCustodyCarrierProjection.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { projectQueueReceipt } from '../../cats/services/stores/ports/queued-message-receipt.js';
import type { ITurnExecutionStore, TurnExecutionStatus } from '../../cats/services/stores/ports/TurnExecutionStore.js';
import type { ContentReturnIntent } from '../artifact-review/return-store.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { isBoundMediaModificationReturn } from './bindings/media-return-binding.js';
import { mediaPublicationProjection } from './media-publication/media-publication-return.js';

const executionStates: Record<TurnExecutionStatus, NonNullable<ContentModificationRequestView['execution']>['state']> =
  {
    canceled: 'cancelled',
    failed: 'failed',
    succeeded: 'finished',
    interrupted: 'interrupted',
    running: 'running',
  };

/** A queue carrier, a started executor and a returned result are separate owner facts. */
export async function readModificationExecution(
  deps: {
    messages: Pick<IMessageStore, 'getByIdempotencyKey'>;
    turnExecutions?: Pick<ITurnExecutionStore, 'get'>;
    store?: Pick<ArtifactReviewStore, 'returns' | 'reviewReceipt'>;
  },
  record: ContentModificationRecord,
): Promise<ContentModificationRequestView['execution']> {
  const publication =
    record.progress.prepared?.kind === 'media'
      ? deps.store?.returns.publicationForRequest(record.requestId)
      : undefined;
  const receiptRef = publication?.receiptRef ?? record.progress.review?.receiptRef;
  if (!receiptRef || !record.progress.task) return;
  const key = `f309-return:${createHash('sha256').update(receiptRef).digest('hex')}`;
  const message = await deps.messages.getByIdempotencyKey(record.ownerUserId, record.payload.threadId, key);
  const sourceMessageId = message
    ? executionSourceMessageId(message.source, record, receiptRef, message.id, deps.store)
    : undefined;
  if (
    !message ||
    message.userId !== record.ownerUserId ||
    message.threadId !== record.payload.threadId ||
    !sourceMessageId ||
    (record.progress.sourceVisibility?.visibility === 'whisper' &&
      (message.visibility !== 'whisper' ||
        JSON.stringify([...(message.whisperTo ?? [])].sort()) !==
          JSON.stringify([...record.progress.sourceVisibility.whisperTo].sort()))) ||
    !message.mentions.includes(record.payload.targetCatId as (typeof message.mentions)[number])
  )
    return;
  const target = message.queueCustody
    ? projectQueueReceipt(message.queueCustody).targets.find((target) => target.catId === record.payload.targetCatId)
    : undefined;
  const latest = target?.attempts?.at(-1);
  const invocationId = latest?.invocationId ?? target?.invocationId;
  const queueEntryId = message.queueCustody
    ? carrierEntryId(message.queueCustody, record.payload.targetCatId)
    : undefined;
  const evidence = {
    messageId: message.id,
    ...(queueEntryId ? { queueEntryId } : {}),
    targetCatId: record.payload.targetCatId,
    ...(invocationId ? { invocationId } : {}),
    observedAt: latest?.updatedAt ?? message.timestamp,
    evidenceRef: `message:${message.id}#queue-custody`,
  };
  if (invocationId && deps.turnExecutions) {
    const invocation = await deps.turnExecutions.get(invocationId);
    if (
      !invocation ||
      invocation.userId !== record.ownerUserId ||
      invocation.threadId !== record.payload.threadId ||
      invocation.catId !== record.payload.targetCatId ||
      ![message.id, sourceMessageId].some(
        (id) => invocation.causal?.triggerMessageId === id || invocation.causal?.coveredMessageIds?.includes(id),
      )
    )
      return { ...evidence, state: 'unknown' };
    const fact = {
      ...evidence,
      parentInvocationId: invocation.parentInvocationId,
      observedAt: invocation.endedAt ?? invocation.startedAt,
      evidenceRef: `turn-execution:${invocation.invocationId}`,
    };
    return {
      ...fact,
      state:
        invocation.status === 'running' && target?.state === 'withdrawn'
          ? 'withdrawn_running'
          : executionStates[invocation.status],
    };
  }
  if (latest?.state === 'failed' || target?.state === 'failed') return { ...evidence, state: 'failed' };
  if (latest?.state === 'interrupted' || target?.state === 'interrupted') return { ...evidence, state: 'interrupted' };
  if (!invocationId && target?.state === 'withdrawn') return { ...evidence, state: 'cancelled' };
  if (!invocationId && target && ['queued', 'notified'].includes(target.state)) return { ...evidence, state: 'queued' };
  return { ...evidence, state: 'unknown' };
}

/** A typed takeover binds the original Human; a later queued turn can instead cover the derived Host carrier. */
function executionSourceMessageId(
  source: ConnectorSource | undefined,
  record: ContentModificationRecord,
  receiptRef: string,
  carrierMessageId: string,
  store?: Pick<ArtifactReviewStore, 'returns' | 'reviewReceipt'>,
): string | undefined {
  if (source?.connector !== 'content-review') return;
  const intent: ContentReturnIntent | null | undefined = store?.returns.get(receiptRef);
  if (intent?.kind === 'resume_media_publication') {
    return intent.requestId === record.requestId &&
      intent.taskId === record.progress.task?.taskId &&
      intent.source.sourceMessageId === record.progress.sourceMessageId &&
      intent.source.requestReceiptRef === record.progress.review?.receiptRef &&
      intent.targetCatId === record.payload.targetCatId &&
      intent.threadId === record.payload.threadId &&
      isDeepStrictEqual(source, mediaPublicationProjection(intent).source)
      ? carrierMessageId
      : undefined;
  }
  const mediaBinding = isBoundMediaModificationReturn(store, record, intent);
  const requestCarrier = contentModificationRequestCarrierV1Schema.safeParse(source.meta);
  if (requestCarrier.success) {
    const matches =
      requestCarrier.data.requestId === record.requestId &&
      requestCarrier.data.sourceMessageId === record.progress.sourceMessageId &&
      requestCarrier.data.targetCatId === record.payload.targetCatId &&
      requestCarrier.data.taskId === record.progress.task?.taskId &&
      requestCarrier.data.expectedTaskRevision === record.progress.task?.revision &&
      requestCarrier.data.requestReceiptRef === receiptRef &&
      (requestCarrier.data.kind === 'request_text_edit'
        ? record.progress.prepared?.kind !== 'media'
        : mediaBinding && requestCarrier.data.kind === intent?.kind);
    if (!matches) return;
    return record.progress.sourceKind === 'human_message' ? requestCarrier.data.sourceMessageId : carrierMessageId;
  }
  if (source.meta?.reviewReceiptRef !== receiptRef || source.meta.taskId !== record.progress.task?.taskId) return;
  // Older public media carriers retain their Queue winner. The canonical outbox/journal, not legacy prose,
  // proves their original Human binding; pre-v1 text envelopes still cannot establish that link.
  if (record.progress.prepared?.kind === 'media' && record.progress.sourceKind === 'human_message')
    return mediaBinding && source.meta.reviewRevision === String(intent?.reviewRevision)
      ? record.progress.sourceMessageId
      : undefined;
  return carrierMessageId;
}
