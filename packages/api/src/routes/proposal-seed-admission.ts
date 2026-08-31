import type { CatId, MessageContent } from '@cat-cafe/shared';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import { createInitialQueuedMessageCustody } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import type { AppendApprovedInitialMessageResult } from './proposal-approve-dispatch.js';
import { admitThreadParticipants } from './thread-participant-admission.js';

type ProposalInvocationQueue = Pick<InvocationQueue, 'enqueue' | 'backfillMessageId' | 'rollbackEnqueue'>;
type ProposalQueueProcessor = Pick<QueueProcessor, 'processNext'>;

/**
 * Lossless source envelope delivered to a child thread when the proposal has no
 * explicit initialMessage. It carries the exact proposal fields (title, reason,
 * sourceMessageId) so the child can verify the original input instead of parsing
 * it out of the thread title.
 */
export interface SourceEnvelope {
  title: string;
  reason: string;
  /** Exact trigger message in the parent thread, if known. */
  sourceMessageId?: string | null;
}

export function buildSourceEnvelopeContent(envelope: SourceEnvelope): string {
  const lines = [`**来源**: ${envelope.title}`, '', envelope.reason];
  if (envelope.sourceMessageId) {
    lines.push('', `**源消息**: \`${envelope.sourceMessageId}\``);
  }
  return lines.join('\n');
}

export async function resolveSourceContentBlocks(
  sourceEnvelope: SourceEnvelope,
  messageStore: IMessageStore,
): Promise<readonly MessageContent[] | undefined> {
  if (!sourceEnvelope.sourceMessageId) {
    return undefined;
  }
  try {
    const sourceMessage = await messageStore.getById(sourceEnvelope.sourceMessageId);
    if (sourceMessage?.contentBlocks && sourceMessage.contentBlocks.length > 0) {
      return sourceMessage.contentBlocks;
    }
  } catch {
    // P2: source-block lookup is best-effort. The approve route has already
    // finalized the proposal; a transient storage failure here must not drop
    // the dispatch. The text envelope is sufficient to wake the assigned cat.
  }
  return undefined;
}

export interface ExistingSeedAdmissionResult {
  kind: 'complete' | 'admitted' | 'failed';
  messageId: string;
  warning?: string;
}

/**
 * #1406 B1 Part 2: a previously materialized seed (e.g. from a queue-full
 * fallback append, or a legacy row written before the idempotency-key index)
 * must be atomically admitted into the queue so it can be driven to a terminal
 * delivery state. Without this, the seed stays in the ambiguous
 * undefined-deliveryStatus state forever and every reconcile retries a brand-new
 * enqueue, risking duplicate invocations once the queue has space.
 */
export async function ensureExistingSeedAdmitted(
  existingSeed: StoredMessage,
  entry: QueueEntry,
  messageStore: IMessageStore,
): Promise<ExistingSeedAdmissionResult> {
  if (existingSeed.deliveryStatus === 'delivered' || existingSeed.deliveryStatus === 'canceled') {
    return { kind: 'complete', messageId: existingSeed.id };
  }

  if (existingSeed.deliveryStatus === 'queued' && existingSeed.queueCustody) {
    return { kind: 'admitted', messageId: existingSeed.id };
  }

  if (existingSeed.deliveryStatus !== 'queued') {
    const prepared = await messageStore.prepareQueueAdmission(existingSeed.id);
    if (prepared.kind === 'conflict') {
      // A concurrent transition may have finished the seed; refresh once.
      const refreshed = await messageStore.getById(existingSeed.id);
      if (refreshed?.deliveryStatus === 'delivered' || refreshed?.deliveryStatus === 'canceled') {
        return { kind: 'complete', messageId: refreshed.id };
      }
      return {
        kind: 'failed',
        messageId: existingSeed.id,
        warning: 'existing seed could not be admitted to queue',
      };
    }
  }

  if (!existingSeed.queueCustody) {
    const custody = createInitialQueuedMessageCustody(entry);
    const initialized = await messageStore.initializeQueueCustody(existingSeed.id, custody);
    if (initialized.kind !== 'initialized' && initialized.kind !== 'existing') {
      return {
        kind: 'failed',
        messageId: existingSeed.id,
        warning: 'existing seed custody initialization failed',
      };
    }
  }

  return { kind: 'admitted', messageId: existingSeed.id };
}

export interface ExecuteQueuedDispatchInput {
  proposalId: string;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  threadId: string;
  content: string;
  targetCats: readonly CatId[];
  intentName: string;
  sourceCatId: CatId | null | undefined;
  crossPostExtra: Record<string, unknown>;
  sourceContentBlocks: readonly MessageContent[] | undefined;
  messageStore: IMessageStore;
  threadStore: Pick<IThreadStore, 'addParticipants' | 'get'>;
  socketManager: Pick<SocketManager, 'emitToUser'>;
  invocationQueue: ProposalInvocationQueue;
  queueProcessor: ProposalQueueProcessor;
  /** A previously materialized seed (legacy or queue-full) to reuse instead of appending a new message. */
  existingSeed?: StoredMessage;
}

export async function executeQueuedDispatch({
  proposalId,
  userId,
  ownerAuthProvenance,
  threadId,
  content,
  targetCats,
  intentName,
  sourceCatId,
  crossPostExtra,
  sourceContentBlocks,
  messageStore,
  threadStore,
  socketManager,
  invocationQueue,
  queueProcessor,
  existingSeed,
}: ExecuteQueuedDispatchInput): Promise<AppendApprovedInitialMessageResult> {
  const idempotencyKey = `proposal-initial:${proposalId}`;
  const enqueueResult = invocationQueue.enqueue({
    threadId,
    userId,
    ownerAuthProvenance,
    idempotencyKey,
    content,
    source: 'user',
    targetCats: targetCats as CatId[],
    intent: intentName,
  });

  if (enqueueResult.outcome === 'full' || !enqueueResult.entry) {
    // Queue-full: if we already have a materialized seed (legacy or prior
    // fallback), leave it in place so reconcile can retry later. Otherwise
    // persist a new materialized seed without queue custody. It is intentionally
    // NOT dispatch-complete so reconcile can CAS-admit it later.
    if (existingSeed) {
      return {
        messageId: existingSeed.id,
        warning: 'initialMessage dispatch skipped: queue is full',
      };
    }
    const stored = await messageStore.append({
      userId,
      catId: sourceCatId ?? null, // AC-AA4
      content,
      mentions: [...targetCats],
      timestamp: Date.now(),
      threadId,
      idempotencyKey,
      extra: crossPostExtra, // AC-AA5
      contentBlocks: sourceContentBlocks,
    });
    return {
      messageId: stored.id,
      warning: 'initialMessage dispatch skipped: queue is full',
    };
  }

  let storedMessageId = enqueueResult.entry.messageId ?? null;
  if (!enqueueResult.deduped || !storedMessageId) {
    // A prior queue-full or failed-persistence attempt may have already
    // materialized the seed. Reuse it atomically instead of appending a second
    // message.
    const seedToAdmit = existingSeed ?? (await messageStore.getByIdempotencyKey(userId, threadId, idempotencyKey));
    if (seedToAdmit) {
      const admission = await ensureExistingSeedAdmitted(seedToAdmit, enqueueResult.entry, messageStore);
      if (admission.kind === 'complete') {
        return { messageId: admission.messageId };
      }
      if (admission.kind === 'failed') {
        invocationQueue.rollbackEnqueue(threadId, userId, enqueueResult.entry.id);
        return { messageId: admission.messageId, warning: admission.warning };
      }
      storedMessageId = admission.messageId;
    } else {
      try {
        const stored = await messageStore.append({
          userId,
          catId: sourceCatId ?? null, // AC-AA4
          content,
          mentions: [...targetCats],
          timestamp: Date.now(),
          threadId,
          idempotencyKey,
          deliveryStatus: 'queued',
          queueCustody: createInitialQueuedMessageCustody(enqueueResult.entry),
          extra: crossPostExtra, // AC-AA5
          contentBlocks: sourceContentBlocks,
        });
        storedMessageId = stored.id;
      } catch (err) {
        invocationQueue.rollbackEnqueue(threadId, userId, enqueueResult.entry.id);
        throw err;
      }
    }
    invocationQueue.backfillMessageId(threadId, userId, enqueueResult.entry.id, storedMessageId);
  }

  // F128 owns the final dispatch plan: preferredCats ordering and explicit
  // parallel intent can differ from raw-message mentions. Admit only those
  // final targets, after Queue accepted a durable carrier and before the
  // processor can start, so Sidebar C2 and C10 cannot contradict each other.
  await admitThreadParticipants({
    userId,
    threadId,
    targetCats,
    threadStore,
    socketManager,
    emitPolicy: 'membership-changed',
  });

  try {
    const started = await queueProcessor.processNext(threadId, userId);
    if (!started.started) {
      return {
        messageId: storedMessageId,
        warning: 'initialMessage queued but did not start automatically',
      };
    }
  } catch (err) {
    return {
      messageId: storedMessageId,
      warning: `initialMessage queued but auto-start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { messageId: storedMessageId };
}
