import { isDeepStrictEqual } from 'node:util';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../owner-auth-provenance.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue } from './InvocationQueue.js';
import {
  ensurePersistedCarrierOwnedAndScheduled,
  type PersistedCarrierDeps,
  type PersistedCarrierResult,
} from './PersistedQueueCarrier.js';
import { carrierEntryId } from './QueuedMessageCustodyCarrierProjection.js';
import { createInitialQueuedMessageCustody } from './QueuedMessageCustodyCoordinator.js';

interface PersistedQueueDeliveryBaseInput {
  ownerAuthProvenance: OwnerAuthProvenance;
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  content: string;
  source: NonNullable<StoredMessage['source']>;
  /** Each producer explicitly declares its stop-gate classification. */
  sourceCategory?: 'producer_return';
}

export type PersistedQueueDeliveryInput = PersistedQueueDeliveryBaseInput &
  (
    | {
        visibility?: 'public';
        whisperTo?: never;
        /** Exact source versions emitted by older deployments. Read only for an existing idempotency winner. */
        compatibleExistingSources?: readonly NonNullable<StoredMessage['source']>[];
      }
    | {
        visibility: 'whisper';
        whisperTo: readonly string[];
        compatibleExistingSources?: never;
      }
  );

export interface PersistedQueueDeliveryPort {
  deliver(input: PersistedQueueDeliveryInput): Promise<PersistedCarrierResult & { message?: StoredMessage }>;
}

/** Dispatch owns the admission/resumption boundary; producers supply only an authorized immutable envelope. */
export class PersistedQueueDelivery implements PersistedQueueDeliveryPort {
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'append' | 'getByIdempotencyKey' | 'getById' | 'getByThreadAfter'>;
      queue: Pick<
        InvocationQueue,
        | 'enqueue'
        | 'backfillMessageId'
        | 'removeEntrySnapshotIfUnchanged'
        | 'getEntrySnapshot'
        | 'restoreDurableEntry'
        | 'commitQueueCustodyAdmission'
      >;
      progress: PersistedCarrierDeps['progress'];
    },
  ) {}

  async deliver(input: PersistedQueueDeliveryInput) {
    requireOwnerAuthProvenance(input.ownerAuthProvenance);
    const audience = deliveryAudience(input);
    let message = await this.deps.messages.getByIdempotencyKey(input.ownerUserId, input.threadId, input.idempotencyKey);
    if (!message) message = await this.admit(input, audience);
    const sourceMatches =
      isDeepStrictEqual(message.source, input.source) ||
      (input.visibility !== 'whisper' &&
        input.compatibleExistingSources?.some((source) => isDeepStrictEqual(message.source, source)) === true);
    if (
      message.userId !== input.ownerUserId ||
      message.threadId !== input.threadId ||
      message.catId !== null ||
      message.content !== input.content ||
      !sourceMatches ||
      !message.mentions.some((cat) => cat === input.targetCatId) ||
      (message.visibility ?? 'public') !== audience.visibility ||
      !isDeepStrictEqual(message.whisperTo ?? [], audience.whisperTo)
    ) {
      return { state: 'conflict' as const, reason: 'Persisted producer envelope does not match', message };
    }
    const result = await ensurePersistedCarrierOwnedAndScheduled(
      {
        ...this.deps,
        progress: async (entry, targetCatId) => {
          // The complete durable group has been verified. Release only this admission's existing queue fence.
          if (
            !this.deps.queue.commitQueueCustodyAdmission(
              entry.threadId,
              entry.userId,
              `producer:${input.idempotencyKey}`,
              [entry.id],
            )
          )
            throw new Error('Producer queue admission fence changed');
          return this.deps.progress(entry, targetCatId);
        },
      },
      { ...input, sourceMessageId: message.id },
    );
    return { ...result, message };
  }

  private async admit(input: PersistedQueueDeliveryInput, audience: DeliveryAudience): Promise<StoredMessage> {
    const targetCat = createCatId(input.targetCatId);
    const queued = this.deps.queue.enqueue({
      threadId: input.threadId,
      userId: input.ownerUserId,
      ownerAuthProvenance: input.ownerAuthProvenance,
      idempotencyKey: input.idempotencyKey,
      queueCustodyAdmissionId: `producer:${input.idempotencyKey}`,
      content: input.content,
      source: 'connector',
      ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
      targetCats: [targetCat],
      intent: 'execute',
    });
    if (queued.outcome === 'full' || !queued.entry) throw new Error('Producer return queue is full');
    const rollbackSnapshot = this.deps.queue.getEntrySnapshot(input.threadId, input.ownerUserId, queued.entry.id);
    const rollbackAdmission = () => {
      if (!queued.deduped && rollbackSnapshot)
        this.deps.queue.removeEntrySnapshotIfUnchanged(rollbackSnapshot, rollbackSnapshot.queueCustodyAdmissionId);
    };
    try {
      const message = await this.deps.messages.append({
        userId: input.ownerUserId,
        catId: null,
        content: input.content,
        mentions: [targetCat],
        timestamp: queued.entry.createdAt,
        threadId: input.threadId,
        idempotencyKey: input.idempotencyKey,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(queued.entry),
        source: input.source,
        ...(audience.visibility === 'whisper'
          ? { visibility: audience.visibility, whisperTo: audience.whisperTo }
          : {}),
        extra: { targetCats: [targetCat] },
      });
      const durableEntryId = message.queueCustody && carrierEntryId(message.queueCustody, input.targetCatId);
      if (durableEntryId !== queued.entry.id) {
        // append's atomic idempotency check may find an older durable owner after our initial lookup.
        rollbackAdmission();
        return message;
      }
      this.deps.queue.backfillMessageId(input.threadId, input.ownerUserId, queued.entry.id, message.id);
      return message;
    } catch (error) {
      rollbackAdmission();
      throw error;
    }
  }
}

interface DeliveryAudience {
  readonly visibility: 'public' | 'whisper';
  readonly whisperTo: readonly CatId[];
}

function deliveryAudience(input: PersistedQueueDeliveryInput): DeliveryAudience {
  if (input.visibility !== 'whisper') {
    if (input.whisperTo !== undefined) throw new Error('Public producer delivery cannot carry whisper recipients');
    return { visibility: 'public', whisperTo: [] };
  }
  if (input.compatibleExistingSources !== undefined) {
    throw new Error('Private producer delivery cannot accept public replay source versions');
  }
  const whisperTo = input.whisperTo.map(createCatId);
  if (whisperTo.length === 0 || !whisperTo.includes(createCatId(input.targetCatId))) {
    throw new Error('Private producer delivery must include its target Cat in the frozen audience');
  }
  if (new Set(whisperTo).size !== whisperTo.length) {
    throw new Error('Private producer delivery audience must not contain duplicate Cats');
  }
  return { visibility: 'whisper', whisperTo };
}
