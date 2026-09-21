import { isDeepStrictEqual } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../../owner-auth-provenance.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import type { OwnedQueueProgress, PersistedCarrierResult } from './PersistedQueueCarrier.js';
import { queueEntryId } from './queue-ledger/QueueLedger.js';

export interface PersistedQueueDeliveryInput {
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  content: string;
  source: NonNullable<StoredMessage['source']>;
  /** Producer-owned envelope metadata (e.g. memory cues); never routing or reliability state. */
  extra?: NonNullable<StoredMessage['extra']>;
  /** RFC §5.1: the envelope states its own urgency; the Queue never infers it from the payload. */
  priority?: 'urgent' | 'normal';
  /**
   * RFC §5.1 lists user, external connector, plugin AND system producers under the same envelope.
   * The producer declares who it is; defaults to the external-connector shape from `source`.
   */
  from?: StoredMessage['from'];
  /** Verified owner provenance for producers that carry an explicit authorization. */
  ownerAuthProvenance?: OwnerAuthProvenance;
  /** Producer hint about which skill this input needs; carried on the Queue row, not inferred. */
  suggestedSkill?: string;
  /** Producer's own category label for the Queue row (ci / review / scheduled / issue / a2a). */
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  /** Structured payload parts (IM media, cards) that belong to the same input as its text. */
  contentBlocks?: StoredMessage['contentBlocks'];
}

/**
 * RFC §5.1's third envelope: an input whose payload belongs only to its target. It is admitted to
 * the same priority Queue and dispatched by the same drain, but it creates no public History
 * message — §5.4: "不在用户 Queue Panel 或聊天面板展示，只在被投递目标的 exact input 中可见".
 */
export interface PrivateQueueDeliveryInput {
  ownerUserId: string;
  threadId: string;
  targetCatId: string;
  idempotencyKey: string;
  /** The exact input the target receives; never projected into the thread. */
  content: string;
  from: NonNullable<StoredMessage['from']>;
  priority?: 'urgent' | 'normal';
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
  ownerAuthProvenance?: OwnerAuthProvenance;
}

export interface PersistedQueueDeliveryPort {
  deliver(input: PersistedQueueDeliveryInput): Promise<PersistedCarrierResult & { message?: StoredMessage }>;
  /** Admit a target-only payload: same Queue, same drain, no public History member. */
  deliverPrivate(input: PrivateQueueDeliveryInput): Promise<{ admitted: boolean; entryId?: string }>;
}

type PersistedQueueDeliveryResult = PersistedCarrierResult & { message?: StoredMessage };

/** Dispatch owns atomic Message + Queue admission; producers supply only an authorized immutable envelope. */
export class PersistedQueueDelivery implements PersistedQueueDeliveryPort {
  constructor(
    private readonly deps: {
      messages: IMessageStore;
      queue: Pick<
        InvocationQueue,
        'appendAndEnqueueDurable' | 'enqueueDurable' | 'findAdmittedEntriesForMessages' | 'getDurableEntry'
      >;
      progress: (entry: QueueEntry, targetCatId: string) => Promise<OwnedQueueProgress>;
    },
  ) {}

  async deliver(input: PersistedQueueDeliveryInput) {
    const targetCat = createCatId(input.targetCatId);
    const from =
      input.from ??
      ({
        kind: 'external' as const,
        connectorId: input.source.connector,
        ...(input.source.label ? { sender: { id: input.source.label, name: input.source.label } } : {}),
      } as NonNullable<StoredMessage['from']>);
    const existing = await this.deps.messages.getByIdempotencyKey(
      input.ownerUserId,
      input.threadId,
      input.idempotencyKey,
    );
    if (existing) {
      return this.progressExistingMessage(existing, input);
    }
    const admitted = await this.deps.queue.appendAndEnqueueDurable(
      this.deps.messages,
      {
        userId: input.ownerUserId,
        threadId: input.threadId,
        from,
        content: input.content,
        mentions: [targetCat],
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        source: input.source,
        extra: { ...(input.extra ?? {}), targetCats: [targetCat] },
        ...(input.contentBlocks ? { contentBlocks: input.contentBlocks } : {}),
        idempotencyKey: input.idempotencyKey,
      },
      {
        threadId: input.threadId,
        userId: input.ownerUserId,
        sourceId: input.idempotencyKey,
        kind: 'conversation_input',
        // Fail closed: a non-user producer that does not state its provenance is `unknown`. A
        // `strict` value is what grants a ManagedWorkBinding (managed-work-invocation-binding.ts),
        // so inheriting it by default would hand external input the owner's managed-work authority.
        ownerAuthProvenance: input.ownerAuthProvenance ?? 'unknown',
        idempotencyKey: input.idempotencyKey,
        content: input.content,
        from,
        targetCats: [targetCat],
        intent: 'execute',
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.suggestedSkill ? { suggestedSkill: input.suggestedSkill } : {}),
        ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
      },
    );
    // Typed like every other queue-full refusal in the codebase (ROUTE_QUEUE_FULL) so callers can
    // tell retryable back-pressure from a genuine fault. A bare Error forces them to either mask
    // real bugs as back-pressure or let back-pressure escape as a 500.
    if (admitted.outcome === 'full') {
      throw Object.assign(new Error('Producer return queue is full'), { code: 'ROUTE_QUEUE_FULL' });
    }
    const message = admitted.message;
    if (!matchesPersistedEnvelope(message, input)) {
      return { state: 'conflict' as const, reason: 'Persisted producer envelope does not match', message };
    }
    const entry = admitted.entry;
    if (!entry) return { state: 'unavailable' as const, reason: 'Queue admission is unavailable', message };
    if (entry.status === 'claimed' || entry.status === 'processing') {
      return { state: 'already_processing' as const, entryId: entry.id, message };
    }
    return { state: await this.deps.progress(entry, input.targetCatId), entryId: entry.id, message };
  }

  async deliverPrivate(input: PrivateQueueDeliveryInput): Promise<{ admitted: boolean; entryId?: string }> {
    const targetCat = createCatId(input.targetCatId);
    const admitted = await this.deps.queue.enqueueDurable({
      threadId: input.threadId,
      userId: input.ownerUserId,
      sourceId: input.idempotencyKey,
      kind: 'private_input',
      ownerAuthProvenance: input.ownerAuthProvenance ?? 'unknown',
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      from: input.from,
      targetCats: [targetCat],
      intent: 'execute',
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
    });
    if (admitted.outcome === 'full') return { admitted: false };
    const entry = admitted.entry;
    if (!entry) return { admitted: false };
    if (entry.status !== 'claimed' && entry.status !== 'processing') {
      await this.deps.progress(entry, input.targetCatId);
    }
    return { admitted: true, entryId: entry.id };
  }

  private async progressExistingMessage(
    existing: StoredMessage,
    input: PersistedQueueDeliveryInput,
  ): Promise<PersistedQueueDeliveryResult> {
    if (!matchesPersistedEnvelope(existing, input)) {
      return { state: 'conflict', reason: 'Persisted producer envelope does not match', message: existing };
    }
    const entryId = queueEntryId(existing.id);
    const entry = await this.deps.queue.getDurableEntry(input.threadId, entryId);
    if (entry) {
      if (entry.status === 'claimed' || entry.status === 'processing') {
        return { state: 'already_processing', entryId, message: existing };
      }
      if (entry.status === 'terminal') return { state: 'terminal_owned', entryId, message: existing };
      return { state: await this.deps.progress(entry, input.targetCatId), entryId, message: existing };
    }
    if (
      this.deps.queue.findAdmittedEntriesForMessages(
        input.threadId,
        [existing.id],
        input.ownerUserId,
        input.targetCatId,
      ).length > 0
    ) {
      return { state: 'already_processing', entryId, message: existing };
    }
    if (existing.deliveryStatus === 'delivered') {
      return { state: 'terminal_owned', entryId, message: existing };
    }
    return { state: 'conflict', reason: 'Persisted producer Queue carrier is missing', message: existing };
  }
}

function matchesPersistedEnvelope(message: StoredMessage, input: PersistedQueueDeliveryInput): boolean {
  return (
    message.userId === input.ownerUserId &&
    message.threadId === input.threadId &&
    message.content === input.content &&
    message.source?.connector === input.source.connector &&
    isDeepStrictEqual(message.source.meta, input.source.meta) &&
    message.mentions.some((cat) => cat === input.targetCatId)
  );
}
