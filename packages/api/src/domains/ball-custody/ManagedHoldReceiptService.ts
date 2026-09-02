import type { CatId } from '@cat-cafe/shared';
import type { InvocationQueue, QueueEntry } from '../cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';

export interface ManagedHoldReceiptInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly invocationId: string;
  readonly sourceMessageId: string;
  readonly taskId: string;
  readonly handledAt: number;
}

export interface ManagedHoldReceiptResult {
  readonly outcome: 'applied' | 'replayed';
  readonly entryId: string;
}

export class ManagedHoldReceiptError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManagedHoldReceiptError';
  }
}

interface ManagedHoldReceiptDeps {
  readonly queue: Pick<InvocationQueue, 'findEntryWithMessageId' | 'getDurableEntry' | 'terminalizeEntryDurable'>;
  readonly messageStore: Pick<IMessageStore, 'getById' | 'markDelivered'>;
  readonly now?: () => number;
  readonly onSettled?: (input: ManagedHoldReceiptInput & { entryId: string }) => void | Promise<void>;
}

function entryMessageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
  return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
}

/**
 * F264 adapter for one managed-hold Queue carrier.
 *
 * It consumes only the exact source/target exposed to this invocation. No
 * thread-wide "mark everything seen as handled" widening is permitted.
 */
export class ManagedHoldReceiptService {
  private readonly now: () => number;

  constructor(private readonly deps: ManagedHoldReceiptDeps) {
    this.now = deps.now ?? Date.now;
  }

  async complete(input: ManagedHoldReceiptInput): Promise<ManagedHoldReceiptResult> {
    const message = await this.deps.messageStore.getById(input.sourceMessageId);
    if (!message || message.threadId !== input.threadId || message.userId !== input.userId) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_missing');
    }

    const sourceTaskId = message.source?.meta?.taskId;
    if (message.source?.connector !== 'hold-ball' || sourceTaskId !== input.taskId) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_source_mismatch');
    }

    const entry = this.deps.queue.findEntryWithMessageId(input.threadId, input.sourceMessageId);
    if (!entry) return this.resolveReplay(input);
    this.assertExactCarrier(entry, input);
    const exposure = entry.queuedBodyExposures?.find(
      (candidate) => candidate.targetCatId === input.catId && candidate.invocationId === input.invocationId,
    );
    if (!exposure) throw new ManagedHoldReceiptError('managed_hold_receipt_invocation_mismatch');
    const handledAt = Math.max(input.handledAt, exposure.seenAt + 1, this.now());
    const delivered = await this.deps.messageStore.markDelivered(input.sourceMessageId, handledAt);
    if (!delivered || (delivered.deliveryStatus !== 'delivered' && delivered.deliveryTransitioned !== true)) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_commit_rejected');
    }
    const terminal = await this.deps.queue.terminalizeEntryDurable(input.threadId, input.userId, entry.id);
    if (!terminal) {
      const replay = await this.resolveReplay(input);
      if (replay.outcome !== 'replayed') throw new ManagedHoldReceiptError('managed_hold_receipt_carrier_changed');
    }
    await this.deps.onSettled?.({ ...input, entryId: entry.id, handledAt });
    return { outcome: 'applied', entryId: entry.id };
  }

  private assertExactCarrier(entry: QueueEntry | null, input: ManagedHoldReceiptInput): asserts entry is QueueEntry {
    if (
      !entry ||
      (entry.status !== 'processing' && entry.status !== 'queued') ||
      entry.threadId !== input.threadId ||
      entry.sourceCategory !== 'scheduled' ||
      entry.targetCats.length !== 1 ||
      entry.targetCats[0] !== (input.catId as CatId) ||
      entry.queuedSeenInvocationIdByCatId?.[input.catId] !== input.invocationId ||
      entryMessageIds(entry).length !== 1 ||
      entryMessageIds(entry)[0] !== input.sourceMessageId
    ) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_carrier_mismatch');
    }
  }

  private async resolveReplay(input: ManagedHoldReceiptInput): Promise<ManagedHoldReceiptResult> {
    const entryId = queueEntryId(input.sourceMessageId, input.catId);
    const row = await this.deps.queue.getDurableEntry(input.threadId, entryId);
    if (
      row?.status !== 'terminal' ||
      row.payload.messageId !== input.sourceMessageId ||
      row.target.kind !== 'cat' ||
      row.target.catId !== input.catId ||
      row.delivery.seenInvocationId !== input.invocationId
    ) {
      throw new ManagedHoldReceiptError('managed_hold_receipt_replay_mismatch');
    }
    return { outcome: 'replayed', entryId };
  }
}
