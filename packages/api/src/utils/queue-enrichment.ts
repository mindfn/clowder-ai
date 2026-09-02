/**
 * Queue Enrichment Utility
 *
 * Enriches raw QueueEntry[] with messagePreview data from MessageStore
 * before sending to the frontend via SSE or HTTP.
 *
 * This is a presentation-layer concern: InvocationQueue stores lightweight
 * pointers; the enrichment layer joins persisted message data at emit time.
 */

import type {
  CatRoutingError,
  MessageContent,
  MessageFrom,
  QueueMessageReceipt,
  QueueMessageReceiptProjection,
} from '@cat-cafe/shared';
import {
  type QueueEntry,
  queueEntryOwnerId,
  queueEntryTargetCats,
} from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueLedgerEntry } from '../domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { projectQueueLedgerReceipt } from '../domains/cats/services/agents/invocation/queue-ledger/QueueLedgerReceipt.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/** Projection of StoredMessage fields useful for QueuePanel / recall-edit. */
export interface QueueEntryMessagePreview {
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
}

/** Stable browser DTO. The durable ledger remains nested and is never leaked to clients. */
export interface EnrichedQueueEntry {
  id: string;
  threadId: string;
  userId: string;
  content: string;
  messageId: string | null;
  mergedMessageIds: string[];
  from: MessageFrom;
  targetCats: string[];
  routingWarnings?: readonly CatRoutingError[];
  intent: string;
  status: 'queued' | 'processing';
  targetStates: Record<
    string,
    'queued' | 'notified' | 'awakened' | 'seen' | 'failed' | 'steering' | 'withdrawn' | 'handled'
  >;
  createdAt: number;
  autoExecute: boolean;
  priority: QueueEntry['priority'];
  sourceCategory?: QueueEntry['sourceCategory'];
  continuationKey?: string;
  position?: number;
  messagePreview?: QueueEntryMessagePreview;
  queueReceipt?: QueueMessageReceipt;
}

export interface QueueUpdatePublicationOptions {
  receiptMessageIds?: readonly string[];
  receiptSource?: {
    getDurableEntriesForMessages(
      threadId: string,
      messageIds: readonly string[],
    ): Promise<Map<string, QueueLedgerEntry[]>>;
  };
}

type QueueUpdateEmitter = Pick<SocketManager, 'emitToUser'>;

const QUEUE_ENRICHMENT_TIMEOUT_MS = 2_000;

/** RFC #1356 private inputs are execution custody, never user-visible Queue rows. */
export function isPublicQueueEntry(entry: Pick<QueueEntry, 'kind'>): boolean {
  return entry.kind !== 'private_input';
}

/**
 * Queue updates are full-state replacements in the browser. Keep one ordered
 * publication tail for each runtime/thread/user scope so a slow older preview
 * lookup cannot arrive after a newer queue mutation. Weak ownership isolates
 * runtime and test SocketManager instances without retaining them globally.
 */
const queueUpdatePublicationTails = new WeakMap<QueueUpdateEmitter, Map<string, Promise<void>>>();

function freezeQueueSnapshot(entries: QueueEntry[]): QueueEntry[] {
  return structuredClone(entries);
}

function publicationTailsFor(socketManager: QueueUpdateEmitter): Map<string, Promise<void>> {
  let tails = queueUpdatePublicationTails.get(socketManager);
  if (!tails) {
    tails = new Map();
    queueUpdatePublicationTails.set(socketManager, tails);
  }
  return tails;
}

function projectTargetState(entry: QueueEntry): EnrichedQueueEntry['targetStates'][string] {
  if (entry.status === 'terminal') {
    if (entry.delivery.terminalOutcome === 'handled') return 'handled';
    if (entry.delivery.terminalOutcome === 'withdrawn') return 'withdrawn';
    return 'failed';
  }
  if (entry.delivery.steerRequestedAt !== undefined) return 'steering';
  if (entry.delivery.failedAt !== undefined) return 'failed';
  if (entry.delivery.seenAt !== undefined) return 'seen';
  if (entry.delivery.awakenedInvocationId) return 'awakened';
  if (entry.delivery.notifiedAt !== undefined) return 'notified';
  return 'queued';
}

export function projectPublicQueueEntry(entry: QueueEntry): EnrichedQueueEntry {
  const targetCats = queueEntryTargetCats(entry);
  const targetStates = Object.fromEntries(targetCats.map((catId) => [catId, projectTargetState(entry)]));
  const queueReceipt = projectQueueLedgerReceipt([entry]);
  return {
    id: entry.id,
    threadId: entry.threadId,
    userId: queueEntryOwnerId(entry),
    content: entry.payload.content,
    messageId: entry.payload.messageId ?? null,
    mergedMessageIds: [],
    from: structuredClone(entry.from),
    targetCats,
    ...(entry.payload.routingWarnings ? { routingWarnings: structuredClone(entry.payload.routingWarnings) } : {}),
    intent: entry.execution.intent,
    status: entry.status === 'queued' ? 'queued' : 'processing',
    targetStates,
    createdAt: entry.enqueuedAt,
    autoExecute: entry.execution.autoExecute,
    priority: entry.priority,
    ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
    ...(entry.sourceCategory === 'continuation' ? { continuationKey: entry.payload.sourceId } : {}),
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    ...(queueReceipt ? { queueReceipt } : {}),
  };
}

/** Scalar ledger rows reference at most one History message. */
function collectMessageIds(entry: Pick<EnrichedQueueEntry, 'messageId'>): string[] {
  return entry.messageId ? [entry.messageId] : [];
}

/** Build a message preview by aggregating content from all related messages. */
async function buildMessageEnrichment(
  msgIds: string[],
  messageStore: IMessageStore,
): Promise<{ messagePreview: QueueEntryMessagePreview } | null> {
  const blocks: MessageContent[] = [];
  let replyTo: string | undefined;

  for (const msgId of msgIds) {
    const msg = await messageStore.getById(msgId);
    if (!msg) continue;
    if (msg.contentBlocks) blocks.push(...msg.contentBlocks);
    if (!replyTo && msg.replyTo) replyTo = msg.replyTo;
  }

  if (blocks.length === 0 && !replyTo) return null;
  return {
    messagePreview: {
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
      ...(replyTo ? { replyTo } : {}),
    },
  };
}

/**
 * Enrich queue entries with message previews from the message store.
 *
 * For entries with a messageId, projects its rich History preview. Returns
 * entries unchanged when messageStore is null or no messageId is available.
 */
export async function enrichQueueEntries(
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  const projected = entries.filter(isPublicQueueEntry).map(projectPublicQueueEntry);
  return enrichProjectedQueueEntries(projected, messageStore);
}

async function enrichProjectedQueueEntries(
  projected: EnrichedQueueEntry[],
  messageStore: IMessageStore | null | undefined,
): Promise<EnrichedQueueEntry[]> {
  if (!messageStore || projected.length === 0) return projected;

  try {
    return await Promise.all(
      projected.map(async (entry) => {
        const msgIds = collectMessageIds(entry);
        if (msgIds.length === 0) return entry;

        const enrichment = await buildMessageEnrichment(msgIds, messageStore);
        return enrichment ? { ...entry, ...enrichment } : entry;
      }),
    );
  } catch {
    // Presentation-layer enrichment must not break queue mutations.
    // Fall back to raw entries on any messageStore error.
    return projected;
  }
}

async function projectMessageReceipts(
  threadId: string,
  messageIds: readonly string[],
  receiptSource: NonNullable<QueueUpdatePublicationOptions['receiptSource']> | undefined,
): Promise<QueueMessageReceiptProjection[]> {
  if (!receiptSource) return [];
  const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))];
  try {
    const entriesByMessage = await receiptSource.getDurableEntriesForMessages(threadId, uniqueMessageIds);
    return uniqueMessageIds.flatMap((messageId) => {
      const queueReceipt = projectQueueLedgerReceipt(entriesByMessage.get(messageId) ?? []);
      return queueReceipt ? [{ messageId, queueReceipt }] : [];
    });
  } catch {
    // Socket projection is recoverable from history hydration. An unavailable
    // receipt source must not suppress the ordered Queue snapshot.
    return [];
  }
}

async function buildQueueUpdateProjectionWithinDeadline(
  threadId: string,
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
  receiptMessageIds: readonly string[],
  receiptSource: QueueUpdatePublicationOptions['receiptSource'],
): Promise<{ queue: EnrichedQueueEntry[]; messageReceipts?: QueueMessageReceiptProjection[] }> {
  const projected = entries.filter(isPublicQueueEntry).map(projectPublicQueueEntry);
  if (!messageStore && !receiptSource) return { queue: projected };
  if (projected.length === 0 && receiptMessageIds.length === 0) return { queue: projected };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), QUEUE_ENRICHMENT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const update = Promise.all([
      enrichProjectedQueueEntries(projected, messageStore),
      projectMessageReceipts(threadId, receiptMessageIds, receiptSource),
    ]).then(([queue, messageReceipts]) => ({
      queue,
      ...(messageReceipts.length > 0 ? { messageReceipts } : {}),
    }));
    return (await Promise.race([update, deadline])) ?? { queue: projected };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Emit an enriched queue_updated SSE event.
 *
 * Convenience wrapper: enriches entries then emits. All 14+ emit points
 * should use this instead of raw socketManager.emitToUser('queue_updated', ...).
 */
export function emitQueueUpdated(
  socketManager: QueueUpdateEmitter,
  userId: string,
  threadId: string,
  entries: QueueEntry[],
  messageStore: IMessageStore | null | undefined,
  action: string,
  options: QueueUpdatePublicationOptions = {},
): Promise<void> {
  const snapshot = freezeQueueSnapshot(entries);
  const receiptMessageIds = [...new Set(options.receiptMessageIds ?? [])];
  const scopeKey = JSON.stringify([threadId, userId]);
  const tails = publicationTailsFor(socketManager);
  const previous = tails.get(scopeKey) ?? Promise.resolve();
  const publication = previous.then(async () => {
    const payload = await buildQueueUpdateProjectionWithinDeadline(
      threadId,
      snapshot,
      messageStore,
      receiptMessageIds,
      options.receiptSource,
    );
    socketManager.emitToUser(userId, 'queue_updated', {
      threadId,
      ...payload,
      action,
    });
  });

  // The caller still observes its own failure, while later publications chain
  // from a neutral tail and remain able to advance the same scope.
  const tail: Promise<void> = publication.catch(() => undefined);
  tails.set(scopeKey, tail);
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  return publication;
}
