/**
 * InvocationQueue
 * Per-thread durable work ledger for user/connector/agent/system dispatch.
 *
 * 与 InvocationTracker（互斥锁，跟踪活跃调用）互补：
 * - InvocationTracker: "谁在跑"
 * - InvocationQueue: "谁在等"
 *
 * The in-memory maps below are a process-local projection only. QueueLedgerStore
 * owns canonical persistence and recovery; every mutation crosses that boundary
 * before the cache is updated.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  CatRoutingError,
  MessageFrom,
  QueueAuthorIntent,
  QueueReminderAttempt,
  QueueTargetAttemptTerminalReason,
  WaitContinuationCarrierV1,
} from '@cat-cafe/shared';
import { isMessageFrom } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type { CallerTraceContext } from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  type ActionSuccessorFence,
  actionSuccessorFencesMatch,
} from '../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type {
  AppendMessageInput,
  IMessageStore,
  LifecycleResponseTerminalPatch,
  StoredMessage,
} from '../../stores/ports/MessageStore.js';
import type { ToolExecutionPolicy } from '../../types.js';
import { compareLifecycleQueueEntries } from './message-lifecycle-queue-order.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';
import { InMemoryQueueLedgerStore } from './queue-ledger/InMemoryQueueLedgerStore.js';
import {
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTerminalOutcome,
  type QueueOwner,
  queueEntryId,
  queueOwner,
} from './queue-ledger/QueueLedger.js';
import { createQueueLedgerAdmission } from './queue-ledger/QueueLedgerAdmission.js';

export type QueueEntry = QueueLedgerEntry;

export interface QueueEnqueueInput {
  threadId: string;
  userId: string;
  owner?: QueueOwner;
  sourceId?: string;
  kind: QueueLedgerEntry['kind'];
  ownerAuthProvenance: OwnerAuthProvenance;
  idempotencyKey?: string;
  content: string;
  messageId?: string | null;
  from: MessageFrom;
  targetCats: string[];
  routingWarnings?: CatRoutingError[];
  authorIntentByCatId?: Record<string, QueueAuthorIntent>;
  intent: string;
  autoExecute?: boolean;
  priority?: QueueLedgerEntry['priority'];
  sourceCategory?: QueueLedgerEntry['sourceCategory'];
  continuationKey?: string;
  a2aParentInvocationId?: string;
  freshnessClosureId?: string;
  freshnessSupplementId?: string;
  freshnessSupplementLineageId?: string;
  freshnessSupplementSeq?: 1 | 2;
  readOnlyToolPolicy?: ToolExecutionPolicy;
  actionSuccessorFence?: ActionSuccessorFence;
  waitContinuationCarrier?: WaitContinuationCarrierV1;
  position?: number;
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  a2aTriggerMessageId?: string;
  dedupeProcessing?: boolean;
}

export function exactA2ASourceMessageIds(entry: Pick<QueueEntry, 'execution' | 'payload'>): string[] {
  return [
    ...new Set(
      [entry.execution.a2aTriggerMessageId, entry.payload.messageId].filter(
        (messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0,
      ),
    ),
  ];
}

export interface EnqueueResult {
  outcome: 'enqueued' | 'full';
  entry?: QueueEntry;
  queuePosition?: number;
  /** True when enqueue returned an existing active entry by idempotency key. */
  deduped?: boolean;
}

export type EnqueueMessageResult =
  | { outcome: 'full' }
  | {
      outcome: 'enqueued';
      message: StoredMessage;
      entry?: QueueEntry;
      entries: QueueEntry[];
      queuePosition?: number;
      deduped: boolean;
    };

export type DurableSteerClaimResult =
  | { outcome: 'claimed'; entries: QueueEntry[]; targetCatId: string }
  | {
      outcome: 'rejected';
      reason: 'entry_not_found' | 'entry_processing' | 'entry_ineligible';
    };

export type DurableMessageClaimResult =
  | { outcome: 'claimed'; entries: QueueEntry[] }
  | { outcome: 'not_found' | 'processing' };

export interface ActionSuccessorQueueRetirement {
  entryId: string;
  threadId: string;
  userId: string;
  messageIds: string[];
}

const MAX_QUEUE_DEPTH = 5;

/**
 * Stable InvocationRecord identity for an ActionSuccessor carrier.
 *
 * Queue row ids are derived from a durable producer identity. ActionSuccessor
 * supplies the lease/generation identity so retries converge on the same row.
 */
export function actionSuccessorInvocationIdempotencyKey(queueIdempotencyKey: string): string {
  return `action-successor:${queueIdempotencyKey}`;
}

export function queueEntrySource(entry: Pick<QueueEntry, 'from'>): 'user' | 'connector' | 'agent' | 'system' {
  if (entry.from.kind === 'user') return 'user';
  if (entry.from.kind === 'agent') return 'agent';
  if (entry.from.kind === 'system') return 'system';
  return 'connector';
}

export function queueEntryCallerCatId(entry: Pick<QueueEntry, 'from'>): string | undefined {
  return entry.from.kind === 'agent' ? entry.from.catId : undefined;
}

export function queueEntrySenderMeta(
  entry: Pick<QueueEntry, 'from'>,
): { readonly id: string; readonly name?: string } | undefined {
  return entry.from.kind === 'external' ? entry.from.sender : undefined;
}

export function queueEntryTargetCats(entry: Pick<QueueEntry, 'target'>): string[] {
  return entry.target.kind === 'cat' ? [entry.target.catId] : [];
}

export function queueEntryOwnerId(entry: Pick<QueueEntry, 'owner'>): string {
  return entry.owner.kind === 'user' ? entry.owner.userId : `system:${entry.owner.service}`;
}

export function queueEntryMessageIds(entry: Pick<QueueEntry, 'payload'>): string[] {
  return entry.payload.messageId ? [entry.payload.messageId] : [];
}

export function isSystemPinnedQueueEntry(entry: Pick<QueueEntry, 'from' | 'sourceCategory'>): boolean {
  return entry.from.kind === 'agent' && entry.sourceCategory === 'continuation';
}

/**
 * Ordinary Queue target-selection paths must never reopen a target whose latest
 * attempt is terminal-failed. The entry itself may still carry eligible siblings
 * or remain visible to lifecycle/recovery code.
 */
export function isOrdinaryQueueTargetEligible(entry: Pick<QueueEntry, 'status' | 'target'>, catId: string): boolean {
  return (
    (entry.status === 'queued' || entry.status === 'claimed') &&
    (entry.target.kind === 'unassigned' || entry.target.catId === catId)
  );
}

function isQueueTargetPending(entry: Pick<QueueEntry, 'status' | 'target'>, catId: string): boolean {
  return entry.status !== 'terminal' && entry.target.kind === 'cat' && entry.target.catId === catId;
}

export class InvocationQueue {
  static readonly STALE_PROCESSING_THRESHOLD_MS = 600_000;

  private readonly log = createModuleLogger('invocation-queue');
  private queues = new Map<string, QueueEntry[]>();
  private lastEnqueuedAt = 0;
  /** Claimed rows remain reversible until tracker admission owns execution. */
  private readonly ledgerClaimIds = new Map<string, string>();

  constructor(private readonly ledgerStore: QueueLedgerStore = new InMemoryQueueLedgerStore()) {}

  private scopeKey(threadId: string, userId: string): string {
    return `${threadId}:${userId}`;
  }

  private queueMatchesThread(q: QueueEntry[], threadId: string): boolean {
    return q.some((entry) => entry.threadId === threadId);
  }

  private getOrCreate(key: string): QueueEntry[] {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    return q;
  }

  private static persistentSourceId(input: QueueEnqueueInput): string {
    const sourceId =
      input.sourceId ??
      input.messageId ??
      input.idempotencyKey ??
      input.continuationKey ??
      input.freshnessSupplementId ??
      input.freshnessClosureId;
    if (!sourceId) throw new Error('durable Queue admission requires a persistent producer identity');
    return sourceId;
  }

  /** Enforce the canonical Queue admission contract on both live and restart paths. */
  private static requireAdmissionContract(input: {
    kind: unknown;
    from: unknown;
    userId?: unknown;
    targetCats: unknown;
    messageId?: unknown;
    a2aTriggerMessageId?: unknown;
    ownerAuthProvenance: unknown;
  }): { kind: QueueEntry['kind']; ownerAuthProvenance: OwnerAuthProvenance } {
    const kind = input.kind;
    if (kind !== 'conversation_input' && kind !== 'message_wake' && kind !== 'private_input') {
      throw new Error('kind must be explicit on every Queue producer');
    }
    if (
      !Array.isArray(input.targetCats) ||
      input.targetCats.some((catId) => typeof catId !== 'string' || catId.length === 0) ||
      new Set(input.targetCats).size !== input.targetCats.length
    ) {
      throw new Error('targetCats must contain unique non-empty target ids');
    }
    if (kind !== 'conversation_input' && input.targetCats.length === 0) {
      throw new Error(`${kind} must have an exact target`);
    }
    if (!isMessageFrom(input.from)) {
      throw new Error('from must be explicit on every Queue producer');
    }
    if (input.from.kind === 'user' && input.from.userId !== input.userId) {
      throw new Error('Queue user sender must match the owner userId');
    }
    if (kind === 'private_input' && input.messageId != null) {
      throw new Error('private_input cannot reference a public History message');
    }
    if (kind === 'message_wake' && !input.messageId && !input.a2aTriggerMessageId) {
      throw new Error('message_wake must reference an existing History message');
    }
    const ownerAuthProvenance = input.ownerAuthProvenance;
    if (
      ownerAuthProvenance !== 'strict' &&
      ownerAuthProvenance !== 'compatibility_fallback' &&
      ownerAuthProvenance !== 'unknown'
    ) {
      throw new Error('ownerAuthProvenance must be explicit on every Queue producer');
    }
    return { kind, ownerAuthProvenance };
  }

  private nextEnqueuedAt(): number {
    const now = Date.now();
    this.lastEnqueuedAt = Math.max(now, this.lastEnqueuedAt + 1);
    return this.lastEnqueuedAt;
  }

  /** RFC #1356's only Queue comparator: position → priority → FIFO → stable id. */
  private static compareEntries(a: QueueEntry, b: QueueEntry): number {
    return compareLifecycleQueueEntries(
      { id: a.id, priority: a.priority, enqueuedAt: a.enqueuedAt, position: a.position },
      { id: b.id, priority: b.priority, enqueuedAt: b.enqueuedAt, position: b.position },
    );
  }

  private createLedgerRows(
    input: QueueEnqueueInput,
    sourceId: string,
    enqueuedAt: number,
    messageId?: string,
  ): QueueLedgerEntry[] {
    InvocationQueue.requireAdmissionContract({ ...input, messageId: messageId ?? input.messageId });
    return createQueueLedgerAdmission({
      sourceId,
      threadId: input.threadId,
      owner: queueOwner(input),
      kind: input.kind,
      from: input.from,
      targetCatIds: input.targetCats,
      content: input.content,
      ...(messageId ? { messageId } : {}),
      ...(input.routingWarnings ? { routingWarnings: input.routingWarnings } : {}),
      ...(input.authorIntentByCatId ? { authorIntentByCatId: input.authorIntentByCatId } : {}),
      intent: input.intent,
      ownerAuthProvenance: input.ownerAuthProvenance,
      autoExecute: input.autoExecute,
      priority: input.priority,
      sourceCategory: input.sourceCategory,
      a2aParentInvocationId: input.a2aParentInvocationId,
      freshnessClosureId: input.freshnessClosureId,
      freshnessSupplementId: input.freshnessSupplementId,
      freshnessSupplementLineageId: input.freshnessSupplementLineageId,
      freshnessSupplementSeq: input.freshnessSupplementSeq,
      readOnlyToolPolicy: input.readOnlyToolPolicy,
      actionSuccessorFence: input.actionSuccessorFence,
      waitContinuationCarrier: input.waitContinuationCarrier,
      suggestedSkill: input.suggestedSkill,
      callerTraceContext: input.callerTraceContext,
      a2aTriggerMessageId: input.a2aTriggerMessageId ?? (input.kind === 'message_wake' ? messageId : undefined),
      enqueuedAt,
    });
  }

  private static projectLedgerEntry(entry: QueueLedgerEntry): QueueEntry {
    return structuredClone(entry);
  }

  private cacheLedgerEntries(entries: readonly QueueLedgerEntry[]): QueueEntry[] {
    const projected: QueueEntry[] = [];
    for (const row of entries) {
      if (row.status === 'terminal') {
        this.removeCachedEntry(row.threadId, row.id);
        continue;
      }
      const entry = InvocationQueue.projectLedgerEntry(row);
      const queue = this.getOrCreate(this.scopeKey(entry.threadId, queueEntryOwnerId(entry)));
      const index = queue.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) queue[index] = entry;
      else queue.push(entry);
      projected.push(structuredClone(entry));
    }
    return projected;
  }

  async hydrateFromLedger(messageStore?: Pick<IMessageStore, 'getById'>): Promise<number> {
    this.queues.clear();
    this.ledgerClaimIds.clear();
    let count = 0;
    for (const threadId of await this.ledgerStore.listThreadIds()) {
      const rows: QueueLedgerEntry[] = [];
      for (const row of await this.ledgerStore.list(threadId)) {
        if (row.status !== 'claimed' || !row.claimId) {
          rows.push(row);
          continue;
        }
        const source = row.payload.messageId ? await messageStore?.getById(row.payload.messageId) : null;
        if (source?.recall || (source?.deliveryStatus && source.deliveryStatus !== 'queued')) {
          const terminal = await this.ledgerStore.commit(threadId, row.id, row.claimId, 'withdrawn', Date.now());
          if (terminal.outcome === 'updated') rows.push(terminal.entry);
          continue;
        }
        const restored = await this.ledgerStore.restore(
          threadId,
          row.id,
          row.claimId,
          row.id === queueEntryId(row.payload.sourceId),
        );
        if (restored.outcome === 'updated') rows.push(restored.entry);
      }
      count += this.cacheLedgerEntries(rows).length;
    }
    return count;
  }

  async enqueueDurable(input: QueueEnqueueInput): Promise<EnqueueResult & { entries?: QueueEntry[] }> {
    const sourceId = InvocationQueue.persistentSourceId(input);
    const enqueuedAt = this.nextEnqueuedAt();
    const rows = this.createLedgerRows(input, sourceId, enqueuedAt, input.messageId ?? undefined);
    const result = await this.ledgerStore.enqueue(rows, input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined);
    if (result.outcome === 'full') return { outcome: 'full' };
    if (result.outcome === 'conflict') throw new Error(`Queue admission identity conflict: ${sourceId}`);
    const entries = this.cacheLedgerEntries(result.entries);
    const primary = entries[0];
    return {
      outcome: 'enqueued',
      ...(primary ? { entry: primary } : {}),
      entries,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.outcome === 'replayed',
    };
  }

  /** Synchronous durable admission for the in-memory store used by local/test hosts. */
  enqueueDurableNow(input: QueueEnqueueInput): EnqueueResult & { entries?: QueueEntry[] } {
    if (!(this.ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('synchronous durable Queue admission requires the in-memory ledger');
    }
    const sourceId = InvocationQueue.persistentSourceId(input);
    const rows = this.createLedgerRows(input, sourceId, this.nextEnqueuedAt(), input.messageId ?? undefined);
    const result = this.ledgerStore.enqueueNow(rows, input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined);
    if (result.outcome === 'full') return { outcome: 'full' };
    if (result.outcome === 'conflict') throw new Error(`Queue admission identity conflict: ${sourceId}`);
    const entries = this.cacheLedgerEntries(result.entries);
    const primary = entries[0];
    return {
      outcome: 'enqueued',
      ...(primary ? { entry: primary } : {}),
      entries,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.outcome === 'replayed',
    };
  }

  /** One storage transaction for a queued Message and its complete Queue fan-out. */
  async appendAndEnqueueDurable(
    messageStore: IMessageStore,
    message: AppendMessageInput,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    if (
      (message.threadId ?? 'default') !== input.threadId ||
      message.userId !== input.userId ||
      message.content !== input.content ||
      JSON.stringify(message.from) !== JSON.stringify(input.from) ||
      (message.deliveryStatus !== 'queued' && !(message.from.kind === 'agent' && message.deliveryStatus === undefined))
    ) {
      throw new Error('atomic Queue admission message does not match its execution work item');
    }
    const enqueuedAt = this.nextEnqueuedAt();
    const result = await messageStore.appendWithQueueLedgerAdmission(
      message,
      (messageId) => this.createLedgerRows(input, messageId, enqueuedAt, messageId),
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.outcome === 'full') return { outcome: 'full' };

    const projected = this.cacheLedgerEntries(result.entries);
    const expected = this.createLedgerRows(input, result.message.id, enqueuedAt, result.message.id);
    const primary =
      projected[0] ??
      (() => {
        const first = expected[0];
        if (!first) return undefined;
        const owner = queueOwner(input);
        const ownerUserId = owner.kind === 'user' ? owner.userId : `system:${owner.service}`;
        return this.findEntry(input.threadId, ownerUserId, first.id);
      })();
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: { ...primary } } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.deduped,
    };
  }

  /** One storage transaction for a terminal response bubble and its outbound A2A fan-out. */
  async terminalizeResponseAndEnqueueDurable(
    messageStore: IMessageStore,
    responseMessageId: string,
    terminalPatch: LifecycleResponseTerminalPatch,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    const source = await messageStore.getById(responseMessageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.userId ||
      source.content === undefined ||
      JSON.stringify(source.from) !== JSON.stringify(input.from)
    ) {
      throw new Error('lifecycle Queue source does not match its execution work item');
    }
    const canonicalInput: QueueEnqueueInput = {
      ...input,
      sourceId: responseMessageId,
      messageId: responseMessageId,
    };
    const rows = this.createLedgerRows(canonicalInput, responseMessageId, source.timestamp, responseMessageId);
    const result = await messageStore.commitLifecycleResponseTerminalWithQueueLedgerAdmission(
      responseMessageId,
      terminalPatch,
      rows,
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.kind === 'full') return { outcome: 'full' };
    if (result.kind !== 'applied' && result.kind !== 'replayed') {
      throw new Error(
        `lifecycle response terminal Queue admission conflict: ${result.kind}:${'reason' in result ? result.reason : 'missing'}`,
      );
    }
    const projected = this.cacheLedgerEntries(result.entries);
    const primary = projected[0];
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: primary } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.ledgerReplayed,
    };
  }

  /** Atomically adopt one already-persisted connector message into the ledger. */
  async enqueueExistingMessageDurable(
    messageStore: IMessageStore,
    messageId: string,
    input: QueueEnqueueInput,
  ): Promise<EnqueueMessageResult> {
    const source = await messageStore.getById(messageId);
    if (
      !source ||
      source.threadId !== input.threadId ||
      source.userId !== input.userId ||
      source.content !== input.content ||
      JSON.stringify(source.from) !== JSON.stringify(input.from)
    ) {
      throw new Error('existing Queue source does not match its execution work item');
    }
    const enqueuedAt = this.nextEnqueuedAt();
    const rows = this.createLedgerRows(input, messageId, enqueuedAt, messageId);
    const result = await messageStore.enqueueExistingMessageWithQueueLedgerAdmission(
      messageId,
      rows,
      this.ledgerStore,
      input.from.kind === 'user' ? MAX_QUEUE_DEPTH : undefined,
    );
    if (result.outcome === 'full') return { outcome: 'full' };
    const projected = this.cacheLedgerEntries(result.entries);
    const primary = projected[0];
    return {
      outcome: 'enqueued',
      message: result.message,
      ...(primary ? { entry: primary } : {}),
      entries: projected,
      queuePosition: primary
        ? this.list(primary.threadId, queueEntryOwnerId(primary)).findIndex((entry) => entry.id === primary.id) + 1
        : undefined,
      deduped: result.deduped,
    };
  }

  private findEntryAcrossUsers(threadId: string, entryId: string): QueueEntry | undefined {
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      const entry = queue.find((candidate) => candidate.id === entryId);
      if (entry) return entry;
    }
    return undefined;
  }

  private async claimLedgerEntry(entry: QueueEntry, selectedTargetCatId?: string): Promise<QueueEntry | null> {
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const bindTargetCatId = entry.target.kind === 'unassigned' ? selectedTargetCatId : undefined;
    const claimed = await this.ledgerStore.claim(entry.threadId, entry.id, claimId, claimedAt, bindTargetCatId);
    if (claimed.outcome !== 'claimed') return null;
    const [projected] = this.cacheLedgerEntries(claimed.entries);
    if (!projected) return null;
    this.ledgerClaimIds.set(projected.id, claimId);
    return structuredClone(projected);
  }

  private cacheLedgerClaim(entries: readonly QueueLedgerEntry[], claimId: string): QueueEntry[] {
    const projected = this.cacheLedgerEntries(entries);
    for (const entry of projected) {
      const cached = this.findEntry(entry.threadId, queueEntryOwnerId(entry), entry.id);
      if (!cached) continue;
      if (projected.length > 1) {
        cached.retiringGroupId = claimId;
        entry.retiringGroupId = claimId;
      }
      this.ledgerClaimIds.set(cached.id, claimId);
    }
    return projected.map((entry) => this.getEntrySnapshot(entry.threadId, queueEntryOwnerId(entry), entry.id) ?? entry);
  }

  async claimExactSteerEntryDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    claimedAt = Date.now(),
  ): Promise<DurableSteerClaimResult> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry) return { outcome: 'rejected', reason: 'entry_not_found' };
    if (entry.status !== 'queued') return { outcome: 'rejected', reason: 'entry_processing' };
    const assignsTargetlessConversation = entry.kind === 'conversation_input' && entry.target.kind === 'unassigned';
    if (
      isSystemPinnedQueueEntry(entry) ||
      (!assignsTargetlessConversation && !isOrdinaryQueueTargetEligible(entry, targetCatId))
    ) {
      return { outcome: 'rejected', reason: 'entry_ineligible' };
    }
    const claimId = randomUUID();
    const claimed = await this.ledgerStore.claim(
      threadId,
      entryId,
      claimId,
      claimedAt,
      assignsTargetlessConversation ? targetCatId : undefined,
      claimedAt,
    );
    if (claimed.outcome !== 'claimed') {
      return {
        outcome: 'rejected',
        reason: claimed.outcome === 'not_found' ? 'entry_not_found' : 'entry_processing',
      };
    }
    return { outcome: 'claimed', entries: this.cacheLedgerClaim(claimed.entries, claimId), targetCatId };
  }

  async restoreClaimedEntries(threadId: string, entryIds: readonly string[]): Promise<boolean> {
    let restoredAll = true;
    for (const entryId of entryIds) {
      const claimId = this.ledgerClaimIds.get(entryId);
      if (!claimId) {
        restoredAll = false;
        continue;
      }
      const cached = this.findEntryAcrossUsers(threadId, entryId);
      const restored = await this.ledgerStore.restore(
        threadId,
        entryId,
        claimId,
        cached ? cached.id === queueEntryId(cached.payload.sourceId) : false,
      );
      if (restored.outcome !== 'updated') {
        restoredAll = false;
        continue;
      }
      this.ledgerClaimIds.delete(entryId);
      this.cacheLedgerEntries([restored.entry]);
    }
    return restoredAll;
  }

  /** Claim one queued row before an external withdrawal side effect. */
  async claimQueuedEntryForWithdrawal(threadId: string, userId: string, entryId: string): Promise<QueueEntry | null> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (!entry || entry.status !== 'queued') return null;
    return this.claimLedgerEntry(entry);
  }

  /** Freeze the complete scalar fan-out for one message before its terminal side effect. */
  async claimMessageEntriesForWithdrawal(
    threadId: string,
    userId: string,
    messageId: string,
    claimedAt = Date.now(),
  ): Promise<DurableMessageClaimResult> {
    const matches = [...this.queues.values()]
      .flat()
      .filter((entry) => entry.threadId === threadId && entry.payload.messageId === messageId);
    if (matches.length === 0 || matches.some((entry) => queueEntryOwnerId(entry) !== userId)) {
      return { outcome: 'not_found' };
    }
    if (matches.some((entry) => entry.status !== 'queued')) return { outcome: 'processing' };
    const claimId = randomUUID();
    const claimed = await this.ledgerStore.claimPrefix(
      threadId,
      matches.map((entry) => entry.id),
      claimId,
      claimedAt,
    );
    if (claimed.outcome !== 'claimed') {
      return { outcome: claimed.outcome === 'not_found' ? 'not_found' : 'processing' };
    }
    return { outcome: 'claimed', entries: this.cacheLedgerClaim(claimed.entries, claimId) };
  }

  /** Commit every row frozen by claimMessageEntriesForWithdrawal as terminal. */
  async commitClaimedMessageWithdrawal(threadId: string, entryIds: readonly string[]): Promise<boolean> {
    let committedAll = true;
    for (const entryId of entryIds) {
      if (!(await this.commitClaimedWithdrawal(threadId, entryId))) committedAll = false;
    }
    return committedAll;
  }

  /** Remove a withdrawal claim after its source-message terminal write succeeds. */
  async commitClaimedWithdrawal(threadId: string, entryId: string): Promise<QueueEntry | null> {
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!claimId) return null;
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'withdrawn', Date.now());
    if (committed.outcome !== 'updated') return null;
    this.ledgerClaimIds.delete(entryId);
    return this.removeCachedEntry(threadId, entryId);
  }

  /** Persist explicit ordering through the same claim/commit CAS as dequeue. */
  async setPositionDurable(threadId: string, userId: string, entryId: string, position: number): Promise<boolean> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind === 'private_input' ||
      isSystemPinnedQueueEntry(entry) ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      return false;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claim(threadId, entryId, claimId, claimedAt);
    if (claimed.outcome !== 'claimed' || !claimed.entries[0]) return false;
    const replacement = structuredClone(claimed.entries[0]);
    replacement.position = position;
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'queued', claimedAt, replacement);
    if (committed.outcome !== 'updated') {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      return false;
    }
    this.cacheLedgerEntries([committed.entry]);
    return true;
  }

  /**
   * Apply a queued-row metadata mutation through the existing ledger claim/commit
   * CAS. This deliberately reuses the five ADR-043 primitives instead of adding
   * a side-channel persistence API for receipts.
   */
  private async mutateQueuedLedgerEntry(
    threadId: string,
    userId: string,
    entryId: string,
    mutate: (entry: QueueLedgerEntry) => boolean,
  ): Promise<{ changed: boolean; entry: QueueEntry } | null> {
    const cached = this.findEntry(threadId, userId, entryId);
    if (!cached || cached.status !== 'queued') return null;
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const claimed = await this.ledgerStore.claim(threadId, entryId, claimId, claimedAt);
    if (claimed.outcome !== 'claimed' || !claimed.entries[0]) return null;
    const replacement = structuredClone(claimed.entries[0]);
    let changed: boolean;
    try {
      changed = mutate(replacement);
    } catch (error) {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      throw error;
    }
    const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'queued', claimedAt, replacement);
    if (committed.outcome !== 'updated') {
      await this.ledgerStore.restore(threadId, entryId, claimId);
      return null;
    }
    const [entry] = this.cacheLedgerEntries([committed.entry]);
    return entry ? { changed, entry } : null;
  }

  /** Update receipt evidence without reopening or replacing processing ownership. */
  private async mutateProcessingLedgerEntry(
    threadId: string,
    userId: string,
    entryId: string,
    mutate: (entry: QueueLedgerEntry) => boolean,
  ): Promise<{ changed: boolean; entry: QueueEntry } | null> {
    const cached = this.findEntry(threadId, userId, entryId);
    if (!cached || cached.status !== 'processing') return null;
    const durable = await this.ledgerStore.get(threadId, entryId);
    if (!durable || durable.status !== 'processing') return null;
    const replacement = structuredClone(durable);
    const changed = mutate(replacement);
    const committed = await this.ledgerStore.commit(
      threadId,
      entryId,
      '',
      'processing_evidence',
      Date.now(),
      replacement,
    );
    if (committed.outcome !== 'updated') return null;
    const [entry] = this.cacheLedgerEntries([committed.entry]);
    return entry ? { changed, entry } : null;
  }

  async requestReminderDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    reminderId: string,
    requestedAt = Date.now(),
  ): Promise<{ attempt: QueueReminderAttempt; idempotent: boolean } | null> {
    let attempt: QueueReminderAttempt | undefined;
    let idempotent = false;
    const result = await this.mutateQueuedLedgerEntry(threadId, userId, entryId, (row) => {
      if (row.target.kind !== 'cat' || row.target.catId !== targetCatId) return false;
      const existing = row.delivery.reminderAttempts?.find(
        (candidate) => candidate.targetCatId === targetCatId && candidate.invocationId === invocationId,
      );
      if (existing) {
        attempt = structuredClone(existing);
        idempotent = true;
        return false;
      }
      attempt = {
        id: reminderId,
        targetCatId,
        invocationId,
        state: 'requested',
        requestedAt,
      };
      row.delivery.reminderAttempts = [...(row.delivery.reminderAttempts ?? []), attempt];
      return true;
    });
    return result && attempt ? { attempt, idempotent } : null;
  }

  async markQueuedSeenDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    seenAt = Date.now(),
  ): Promise<{ changed: boolean; newlySeen: boolean }> {
    let newlySeen = false;
    const result = await this.mutateQueuedLedgerEntry(threadId, userId, entryId, (row) => {
      if (row.target.kind !== 'cat' || row.target.catId !== targetCatId) return false;
      const exposure = InvocationQueue.applyQueuedExposure(row, targetCatId, invocationId, seenAt);
      newlySeen = exposure.newlySeen;
      return exposure.changed;
    });
    return { changed: result?.changed ?? false, newlySeen: Boolean(result && newlySeen) };
  }

  async markProcessingAwakenedDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    awakenedAt = Date.now(),
  ): Promise<boolean> {
    let identityConflict = false;
    let targetMismatch = false;
    const result = await this.mutateProcessingLedgerEntry(threadId, userId, entryId, (row) => {
      if (row.target.kind !== 'cat' || row.target.catId !== targetCatId) {
        targetMismatch = true;
        return false;
      }
      if (row.delivery.awakenedInvocationId && row.delivery.awakenedInvocationId !== invocationId) {
        identityConflict = true;
        return false;
      }
      let changed = false;
      if (!row.delivery.awakenedInvocationId) {
        row.delivery.awakenedInvocationId = invocationId;
        changed = true;
      }
      if (row.delivery.awakenedAt === undefined) {
        row.delivery.awakenedAt = awakenedAt;
        changed = true;
      }
      return changed;
    });
    return Boolean(result && !identityConflict && !targetMismatch);
  }

  async markProcessingSeenDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    seenAt = Date.now(),
  ): Promise<{ changed: boolean; newlySeen: boolean }> {
    let newlySeen = false;
    const result = await this.mutateProcessingLedgerEntry(threadId, userId, entryId, (row) => {
      if (row.target.kind !== 'cat' || row.target.catId !== targetCatId) return false;
      const exposure = InvocationQueue.applyQueuedExposure(row, targetCatId, invocationId, seenAt);
      newlySeen = exposure.newlySeen;
      return exposure.changed;
    });
    return { changed: result?.changed ?? false, newlySeen: Boolean(result && newlySeen) };
  }

  private static applyQueuedExposure(
    row: QueueLedgerEntry,
    targetCatId: string,
    invocationId: string,
    seenAt: number,
  ): { changed: boolean; newlySeen: boolean } {
    let changed = false;
    const newlySeen = row.delivery.seenAt === undefined;
    if (newlySeen) {
      row.delivery.seenAt = seenAt;
      changed = true;
    }
    if (row.delivery.seenInvocationId !== invocationId) {
      row.delivery.seenInvocationId = invocationId;
      changed = true;
    }
    if (row.delivery.notifiedAt !== undefined) {
      delete row.delivery.notifiedAt;
      changed = true;
    }
    if (
      !(row.delivery.bodyExposures ?? []).some(
        (exposure) => exposure.targetCatId === targetCatId && exposure.invocationId === invocationId,
      )
    ) {
      row.delivery.bodyExposures = [...(row.delivery.bodyExposures ?? []), { targetCatId, invocationId, seenAt }];
      changed = true;
    }
    const attempts = (row.delivery.reminderAttempts ?? []).map((candidate) => {
      if (
        candidate.targetCatId !== targetCatId ||
        candidate.invocationId !== invocationId ||
        (candidate.state !== 'requested' && candidate.state !== 'delivered')
      ) {
        return candidate;
      }
      changed = true;
      return { ...candidate, state: 'seen' as const, seenAt };
    });
    if (changed && row.delivery.reminderAttempts) row.delivery.reminderAttempts = attempts;
    return { changed, newlySeen };
  }

  /** Claim one exact source×target row before binding a full-body read to its active child. */
  async claimExactExposureDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    messageId: string,
  ): Promise<QueueEntry | null> {
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.target.kind !== 'cat' ||
      entry.target.catId !== targetCatId ||
      entry.payload.messageId !== messageId
    ) {
      return null;
    }
    return this.claimLedgerEntry(entry);
  }

  /**
   * Persist full-body exposure and terminal handling on the already claimed
   * scalar row. Sibling targets are different ledger rows and remain queued.
   */
  async commitClaimedExposureDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    seenAt: number,
  ): Promise<{ entry: QueueEntry; newlySeen: boolean } | null> {
    const snapshot = this.getEntrySnapshot(threadId, userId, entryId);
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!snapshot || snapshot.status !== 'claimed' || !claimId) return null;
    const durable = await this.ledgerStore.get(threadId, entryId);
    if (!durable || durable.target.kind !== 'cat' || durable.target.catId !== targetCatId) return null;
    const replacement = structuredClone(durable);
    const exposure = InvocationQueue.applyQueuedExposure(replacement, targetCatId, invocationId, seenAt);
    const processing = await this.ledgerStore.commit(threadId, entryId, claimId, 'processing', seenAt, replacement);
    if (processing.outcome !== 'updated') return null;
    this.ledgerClaimIds.delete(entryId);
    this.cacheLedgerEntries([processing.entry]);
    const entry = await this.removeProcessedAcrossUsersDurable(threadId, entryId, 'handled', undefined, seenAt);
    return entry ? { entry, newlySeen: exposure.newlySeen } : null;
  }

  async markQueuedNotifiedAndReminderDeliveredDurable(
    threadId: string,
    userId: string,
    entryId: string,
    targetCatId: string,
    invocationId: string,
    deliveredAt = Date.now(),
  ): Promise<boolean> {
    const result = await this.mutateQueuedLedgerEntry(threadId, userId, entryId, (row) => {
      if (row.target.kind !== 'cat' || row.target.catId !== targetCatId) return false;
      let changed = false;
      if (row.delivery.seenAt === undefined && row.delivery.notifiedAt === undefined) {
        row.delivery.notifiedAt = deliveredAt;
        changed = true;
      }
      const attempts = (row.delivery.reminderAttempts ?? []).map((candidate) => {
        if (
          candidate.targetCatId !== targetCatId ||
          candidate.invocationId !== invocationId ||
          candidate.state !== 'requested'
        ) {
          return candidate;
        }
        changed = true;
        return { ...candidate, state: 'delivered' as const, deliveredAt };
      });
      if (changed && row.delivery.reminderAttempts) row.delivery.reminderAttempts = attempts;
      return changed;
    });
    return result?.changed ?? false;
  }

  async claimPreAdmissionFailureAcrossUsersDurable(threadId: string, entryId: string): Promise<QueueEntry | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (!best || best.id !== entryId) return null;
    return this.claimLedgerEntry(best);
  }

  /** Durable counterpart of markProcessingAcrossUsers. */
  async markProcessingDurable(
    threadId: string,
    userId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): Promise<QueueEntry | null> {
    const best = this.peekNextQueued(threadId, userId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      resolvedHead.targetCats.length === 0 ||
      resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
      new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    if (best.target.kind === 'cat' && best.target.catId !== selectedTargetCatId) return null;
    return this.claimLedgerEntry(best, selectedTargetCatId);
  }

  /** Durable counterpart of markProcessingAcrossUsers. */
  async markProcessingAcrossUsersDurable(
    threadId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
  ): Promise<QueueEntry | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      resolvedHead.targetCats.length === 0 ||
      resolvedHead.targetCats.some((catId) => typeof catId !== 'string' || !catId) ||
      new Set(resolvedHead.targetCats).size !== resolvedHead.targetCats.length
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    if (best.target.kind === 'cat' && best.target.catId !== selectedTargetCatId) return null;
    return this.claimLedgerEntry(best, selectedTargetCatId);
  }

  async markProcessingGroupAcrossUsersDurable(
    threadId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
    entryIds: readonly string[],
  ): Promise<{ entry: QueueEntry; members: QueueEntry[] } | null> {
    const best = this.peekOldestAcrossUsers(threadId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      entryIds[0] !== best.id ||
      entryIds.length === 0 ||
      new Set(entryIds).size !== entryIds.length ||
      resolvedHead.targetCats.length !== 1
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    const selected = entryIds.map((entryId) => this.findEntryAcrossUsers(threadId, entryId));
    if (
      selected.some(
        (entry) =>
          !entry ||
          entry.status !== 'queued' ||
          queueEntryOwnerId(entry) !== queueEntryOwnerId(best) ||
          (entry.target.kind === 'cat' && entry.target.catId !== selectedTargetCatId),
      )
    ) {
      return null;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const bindsTargetlessGroup = selected.every((entry) => entry?.target.kind === 'unassigned');
    const claimed = await this.ledgerStore.claimPrefix(
      threadId,
      entryIds,
      claimId,
      claimedAt,
      bindsTargetlessGroup ? selectedTargetCatId : undefined,
    );
    if (claimed.outcome !== 'claimed') return null;
    const projected = this.cacheLedgerClaim(claimed.entries, claimId);
    const byId = new Map(projected.map((entry) => [entry.id, entry]));
    const primary = byId.get(best.id);
    if (!primary) return null;
    return {
      entry: primary,
      members: entryIds
        .slice(1)
        .map((entryId) => byId.get(entryId))
        .filter((entry): entry is QueueEntry => !!entry),
    };
  }

  async markProcessingGroupDurable(
    threadId: string,
    userId: string,
    resolvedHead: { readonly entryId: string; readonly targetCats: readonly string[] },
    entryIds: readonly string[],
  ): Promise<{ entry: QueueEntry; members: QueueEntry[] } | null> {
    const best = this.peekNextQueued(threadId, userId);
    if (
      !best ||
      best.id !== resolvedHead.entryId ||
      entryIds[0] !== best.id ||
      entryIds.length === 0 ||
      new Set(entryIds).size !== entryIds.length ||
      resolvedHead.targetCats.length !== 1
    ) {
      return null;
    }
    const selectedTargetCatId = resolvedHead.targetCats[0]!;
    const selected = entryIds.map((entryId) => this.findEntry(threadId, userId, entryId));
    if (
      selected.some(
        (entry) =>
          !entry ||
          entry.status !== 'queued' ||
          (entry.target.kind === 'cat' && entry.target.catId !== selectedTargetCatId),
      )
    ) {
      return null;
    }
    const claimId = randomUUID();
    const claimedAt = Date.now();
    const bindsTargetlessGroup = selected.every((entry) => entry?.target.kind === 'unassigned');
    const claimed = await this.ledgerStore.claimPrefix(
      threadId,
      entryIds,
      claimId,
      claimedAt,
      bindsTargetlessGroup ? selectedTargetCatId : undefined,
    );
    if (claimed.outcome !== 'claimed') return null;
    const projected = this.cacheLedgerClaim(claimed.entries, claimId);
    const byId = new Map(projected.map((entry) => [entry.id, entry]));
    const primary = byId.get(best.id);
    if (!primary) return null;
    return {
      entry: primary,
      members: entryIds
        .slice(1)
        .map((entryId) => byId.get(entryId))
        .filter((entry): entry is QueueEntry => !!entry),
    };
  }

  async markProcessingByIdDurable(threadId: string, entryId: string, targetCatId: string): Promise<QueueEntry | null> {
    const entry = this.findEntryAcrossUsers(threadId, entryId);
    if (!entry || entry.status !== 'queued') return null;
    if (entry.target.kind === 'cat' && entry.target.catId !== targetCatId) return null;
    return this.claimLedgerEntry(entry, targetCatId);
  }

  async commitClaimedProcessing(threadId: string, entryIds: readonly string[], at = Date.now()): Promise<boolean> {
    for (const entryId of entryIds) {
      const claimId = this.ledgerClaimIds.get(entryId);
      if (!claimId) continue;
      const cached = this.findEntryAcrossUsers(threadId, entryId);
      const committed = await this.ledgerStore.commit(threadId, entryId, claimId, 'processing', at, cached);
      if (committed.outcome !== 'updated') return false;
      this.ledgerClaimIds.delete(entryId);
      this.cacheLedgerEntries([committed.entry]);
    }
    return true;
  }

  async rollbackProcessingDurable(threadId: string, entryId: string): Promise<boolean> {
    const claimId = this.ledgerClaimIds.get(entryId);
    if (!claimId) return false;
    const cached = this.findEntryAcrossUsers(threadId, entryId);
    const restored = await this.ledgerStore.restore(
      threadId,
      entryId,
      claimId,
      cached ? cached.id === queueEntryId(cached.payload.sourceId) : false,
    );
    if (restored.outcome !== 'updated') return false;
    this.ledgerClaimIds.delete(entryId);
    this.cacheLedgerEntries([restored.entry]);
    return true;
  }

  private removeCachedEntry(threadId: string, entryId: string): QueueEntry | null {
    for (const queue of this.queues.values()) {
      if (!this.queueMatchesThread(queue, threadId)) continue;
      const index = queue.findIndex((entry) => entry.id === entryId);
      if (index < 0) continue;
      return queue.splice(index, 1)[0] ?? null;
    }
    return null;
  }

  async removeProcessedAcrossUsersDurable(
    threadId: string,
    entryId: string,
    terminalOutcome: Exclude<QueueLedgerTerminalOutcome, 'withdrawn'> = 'handled',
    failureReason?: QueueTargetAttemptTerminalReason,
    terminalAt = Date.now(),
  ): Promise<QueueEntry | null> {
    const snapshot = this.findEntryAcrossUsers(threadId, entryId);
    if (!snapshot || (snapshot.status !== 'claimed' && snapshot.status !== 'processing')) return null;
    const claimId = this.ledgerClaimIds.get(entryId);
    if (claimId) {
      const processing = await this.ledgerStore.commit(threadId, entryId, claimId, 'processing', terminalAt);
      if (processing.outcome !== 'updated') return null;
      this.ledgerClaimIds.delete(entryId);
    }
    const durable = await this.ledgerStore.get(threadId, entryId);
    if (!durable) return null;
    const replacement = structuredClone(durable);
    replacement.delivery.terminalOutcome = terminalOutcome;
    if (terminalOutcome === 'handled') {
      replacement.delivery.handledAt = terminalAt;
      delete replacement.delivery.failedAt;
      delete replacement.delivery.failureReason;
    } else {
      replacement.delivery.failedAt = terminalAt;
      if (failureReason) replacement.delivery.failureReason = failureReason;
    }
    const terminal = await this.ledgerStore.commit(threadId, entryId, '', 'terminal', terminalAt, replacement);
    if (terminal.outcome !== 'updated') return null;
    return this.removeCachedEntry(threadId, entryId);
  }

  async removeProcessedDurable(threadId: string, userId: string, entryId: string): Promise<QueueEntry | null> {
    const snapshot = this.getEntrySnapshot(threadId, userId, entryId);
    if (!snapshot) return null;
    return this.removeProcessedAcrossUsersDurable(threadId, entryId);
  }

  /** Terminalize one exact row without manufacturing a rollback path. */
  async terminalizeEntryDurable(
    threadId: string,
    userId: string,
    entryId: string,
    terminalOutcome: Exclude<QueueLedgerTerminalOutcome, 'withdrawn'> = 'handled',
    failureReason?: QueueTargetAttemptTerminalReason,
  ): Promise<QueueEntry | null> {
    const snapshot = this.getEntrySnapshot(threadId, userId, entryId);
    if (!snapshot) return null;
    if (snapshot.status === 'queued') {
      const claimed = await this.claimQueuedEntryForWithdrawal(threadId, userId, entryId);
      if (!claimed) return null;
      if (!(await this.commitClaimedProcessing(threadId, [entryId]))) {
        await this.restoreClaimedEntries(threadId, [entryId]);
        return null;
      }
      return this.removeProcessedAcrossUsersDurable(threadId, entryId, terminalOutcome, failureReason);
    }
    // A reversible claim is projected as processing for legacy readers. Do not
    // steal another action's in-flight authority.
    if (this.ledgerClaimIds.has(entryId)) return null;
    return this.removeProcessedAcrossUsersDurable(threadId, entryId, terminalOutcome, failureReason);
  }

  async getDurableEntry(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    return this.ledgerStore.get(threadId, entryId);
  }

  async getDurableEntriesForMessages(
    threadId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, QueueLedgerEntry[]>> {
    return this.ledgerStore.getByMessageIds(threadId, messageIds);
  }

  /**
   * A restarted host cannot still own provider execution. Persist every stale
   * processing row as terminal before exposing the remaining Queue for drain.
   */
  async terminalizeRestartedProcessing(): Promise<{ terminalized: number; failedEntryIds: string[] }> {
    const processing = [...this.queues.values()]
      .flat()
      .filter((entry) => entry.status === 'processing')
      .map((entry) => ({ threadId: entry.threadId, id: entry.id }));
    const failedEntryIds: string[] = [];
    let terminalized = 0;
    for (const entry of processing) {
      if (await this.removeProcessedAcrossUsersDurable(entry.threadId, entry.id, 'interrupted', 'runtime_restart'))
        terminalized += 1;
      else failedEntryIds.push(entry.id);
    }
    return { terminalized, failedEntryIds };
  }

  /** Check if any entry in the thread already carries this messageId (connector retry dedup). */
  hasEntryWithMessageId(threadId: string, messageId: string): boolean {
    return this.findEntryWithMessageId(threadId, messageId) !== null;
  }

  /** Return the exact Queue carrier for a persisted message across user scopes. */
  findEntryWithMessageId(threadId: string, messageId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find((e) => e.payload.messageId === messageId);
      if (entry) return structuredClone(entry);
    }
    return null;
  }

  /** Backfill messageId on a new entry (null → value). */
  async retireActionSuccessorFenceDurable(fence: ActionSuccessorFence): Promise<ActionSuccessorQueueRetirement[]> {
    const retired: ActionSuccessorQueueRetirement[] = [];
    const matches = [...this.queues.values()]
      .flat()
      .filter((entry) => actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence));
    for (const entry of matches) {
      const ownerId = queueEntryOwnerId(entry);
      if (await this.terminalizeEntryDurable(entry.threadId, ownerId, entry.id)) {
        retired.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: ownerId,
          messageIds: exactA2ASourceMessageIds(entry),
        });
      }
    }
    return retired;
  }

  /** Read the exact process carriers before durable custody retirement. */
  listActionSuccessorFence(fence: ActionSuccessorFence): ActionSuccessorQueueRetirement[] {
    const matches: ActionSuccessorQueueRetirement[] = [];
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (!actionSuccessorFencesMatch(entry.execution.actionSuccessorFence, fence)) continue;
        matches.push({
          entryId: entry.id,
          threadId: entry.threadId,
          userId: queueEntryOwnerId(entry),
          messageIds: exactA2ASourceMessageIds(entry),
        });
      }
    }
    return matches;
  }

  /** Shallow copy of all entries sorted by dequeue priority (comparator order). */
  list(threadId: string, userId: string): QueueEntry[] {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return [];
    return [...q].sort(InvocationQueue.compareEntries).map((entry) => structuredClone(entry));
  }

  /** Canonical hydrated scopes used to resume pending ledger work after startup. */
  listScopes(): Array<{ threadId: string; userId: string }> {
    const scopes: Array<{ threadId: string; userId: string }> = [];
    for (const queue of this.queues.values()) {
      const first = queue[0];
      if (first) scopes.push({ threadId: first.threadId, userId: queueEntryOwnerId(first) });
    }
    return scopes;
  }

  /** Exact process-local Queue snapshot fence used by explicit row actions. */
  snapshotRevision(threadId: string, userId: string): string {
    return createHash('sha256')
      .update(JSON.stringify(this.list(threadId, userId)))
      .digest('base64url');
  }

  /**
   * Claim one selected public row without borrowing ordinary head-dequeue
   * semantics. Revision and the complete target set are checked in the same
   * synchronous mutation that crosses queued -> processing.
   */
  async claimExactAppend(
    threadId: string,
    userId: string,
    entryId: string,
    expectedQueueRevision: string,
    expectedTargetIds: readonly string[],
  ): Promise<QueueEntry | null> {
    if (this.snapshotRevision(threadId, userId) !== expectedQueueRevision) return null;
    const entry = this.findEntry(threadId, userId, entryId);
    if (
      !entry ||
      entry.status !== 'queued' ||
      entry.kind === 'private_input' ||
      isSystemPinnedQueueEntry(entry) ||
      expectedTargetIds.length === 0 ||
      expectedTargetIds.length !== queueEntryTargetCats(entry).length ||
      expectedTargetIds.some((targetId, index) => targetId !== queueEntryTargetCats(entry)[index]) ||
      expectedTargetIds.some((targetId) => !isOrdinaryQueueTargetEligible(entry, targetId))
    ) {
      return null;
    }
    return this.claimLedgerEntry(entry);
  }

  /** Persist the exact Active Run body exposure before the Queue row is detached. */
  getEntrySnapshot(threadId: string, userId: string, entryId: string): QueueEntry | null {
    const entry = this.findEntry(threadId, userId, entryId);
    return entry ? structuredClone(entry) : null;
  }

  /** Resolve a durable carrier by its globally unique entry id without trusting a source-thread projection. */

  /** Restore one exact TTL-0 Queue owner after process restart or failed persistence. Idempotent by entryId. */
  getQueuedFreshnessMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
    opts?: { excludeEntryId?: string; parentInvocationId?: string },
  ): Array<{
    entryId: string;
    from: MessageFrom;
    content: string;
    messageId?: string | null;
    sourceCategory?: QueueEntry['sourceCategory'];
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.id !== opts?.excludeEntryId)
      .filter((entry) => entry.status === 'queued' && isOrdinaryQueueTargetEligible(entry, catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, opts?.parentInvocationId))
      .filter((entry) => entry.delivery.seenAt === undefined)
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.payload.content,
        ...(entry.payload.messageId !== undefined ? { messageId: entry.payload.messageId } : {}),
        ...(entry.sourceCategory ? { sourceCategory: entry.sourceCategory } : {}),
      }));
  }

  /** Queued bodies readable by a target cat until one exact active child adopts them. */
  getQueuedBodyMessagesForCat(
    threadId: string,
    userId: string,
    catId: string,
    parentInvocationId?: string,
  ): Array<{
    entryId: string;
    from: MessageFrom;
    content: string;
    messageId?: string | null;
    alreadyExposed: boolean;
  }> {
    return this.list(threadId, userId)
      .filter((entry) => entry.status === 'queued' && isOrdinaryQueueTargetEligible(entry, catId))
      .filter((entry) => InvocationQueue.canExposeToCurrentParent(entry, catId, parentInvocationId))
      .map((entry) => ({
        entryId: entry.id,
        from: structuredClone(entry.from),
        content: entry.payload.content,
        alreadyExposed: Boolean(entry.delivery.bodyExposures?.some((exposure) => exposure.targetCatId === catId)),
        ...(entry.payload.messageId !== undefined ? { messageId: entry.payload.messageId } : {}),
      }));
  }

  private static canExposeToCurrentParent(
    entry: Pick<QueueEntry, 'from' | 'delivery'>,
    catId: string,
    parentInvocationId: string | undefined,
  ): boolean {
    // Author disposition belongs only to human-authored work. Agent and connector
    // carriers retain their typed custody/continuation path and may be read at a
    // current safe boundary without manufacturing a human queue preference.
    if (entry.from.kind !== 'user') return true;
    if (entry.delivery.bodyExposures?.some((exposure) => exposure.targetCatId === catId)) return true;
    const authorIntent = entry.delivery.authorIntent;
    return Boolean(
      parentInvocationId &&
        authorIntent?.requested === 'continue_current' &&
        authorIntent.fallbackAt === undefined &&
        authorIntent.boundParentInvocationId === parentInvocationId,
    );
  }

  size(threadId: string, userId: string): number {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return 0;
    return q.filter((e) => e.status === 'queued').length;
  }

  /**
   * Move entry up or down in comparator order by swapping positions with its neighbor.
   * Returns false if entry is processing or not found.
   */
  peekNextQueued(threadId: string, userId: string): QueueEntry | null {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    if (!q) return null;
    const queued = q.filter((entry) => entry.status === 'queued');
    if (queued.length === 0) return null;
    queued.sort(InvocationQueue.compareEntries);
    return structuredClone(queued[0]!);
  }

  /** Rollback a processing entry back to queued (undo markProcessing/markProcessingAcrossUsers). */
  peekOldestAcrossUsers(threadId: string): QueueEntry | null {
    let best: QueueEntry | null = null;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.status !== 'queued') continue;
        if (!best || InvocationQueue.compareEntries(e, best) < 0) {
          best = e;
        }
      }
    }
    return best ? { ...best } : null;
  }

  /** Mark the strict comparator head across users as processing. */
  getProcessingGroupAcrossUsers(threadId: string, entryId: string): QueueEntry[] | null {
    const selected = this.findEntryAcrossUsers(threadId, entryId);
    if (!selected || (selected.status !== 'claimed' && selected.status !== 'processing')) return null;
    if (!selected.retiringGroupId) return [structuredClone(selected)];
    const group = [...this.queues.values()]
      .flat()
      .filter(
        (entry) =>
          entry.threadId === threadId &&
          (entry.status === 'claimed' || entry.status === 'processing') &&
          entry.retiringGroupId === selected.retiringGroupId,
      );
    return group.length > 0 ? group.map((entry) => structuredClone(entry)) : null;
  }

  /**
   * Atomically tombstone one processing carrier and every member of its exact
   * Steer reservation. Supersession paths use this instead of treating the
   * primary row as the whole reservation. Ordinary attempt settlement remains
   * per-entry and must keep using removeProcessedAcrossUsers.
   */
  findProcessingByCat(threadId: string, catId: string, excludeEntryId?: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      const entry = q.find(
        (e) =>
          (e.status === 'claimed' || e.status === 'processing') &&
          e.id !== excludeEntryId &&
          e.target.kind === 'cat' &&
          e.target.catId === catId,
      );
      if (entry) return structuredClone(entry);
    }
    return null;
  }

  /** Get unique userIds that have entries (any status) for this thread. */
  listUsersForThread(threadId: string): string[] {
    const users: string[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId) || q.length === 0) continue;
      users.push(queueEntryOwnerId(q[0]!));
    }
    return users;
  }

  /** F122B: List all queued autoExecute entries for a thread (for scanning past busy slots). */
  listAutoExecute(threadId: string): QueueEntry[] {
    const result: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (
          e.status !== 'queued' ||
          !e.execution.autoExecute ||
          (e.target.kind === 'cat' && !isOrdinaryQueueTargetEligible(e, e.target.catId))
        )
          continue;
        result.push(structuredClone(e));
      }
    }
    return result;
  }

  /** F122B: Count queued+processing agent-sourced entries for a thread (depth tracking).
   *  Queued entries are valid pending work regardless of age; processing entries
   *  have their own stale guard in hasActiveOrQueuedAgentForCat/hasPendingForCat. */
  countAgentEntriesForThread(threadId: string): number {
    let count = 0;
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.from.kind !== 'agent' || e.target.kind !== 'cat' || !isQueueTargetPending(e, e.target.catId)) continue;
        count++;
      }
    }
    return count;
  }

  /** F122B: Check if a specific cat already has a queued agent entry for this thread.
   *  Used by callback-a2a-trigger for dedup — only checks 'queued' so that new handoffs
   *  can still be enqueued while an earlier entry is processing.
   */
  hasQueuedAgentForCat(threadId: string, catId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (e.from.kind === 'agent' && e.status === 'queued' && isQueueTargetPending(e, catId)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Cross-path dedup guard for queued or live agent work targeting one cat. */
  hasActiveOrQueuedAgentForCat(threadId: string, catId: string, opts?: { excludeEntryId?: string }): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (e.from.kind !== 'agent' || !isQueueTargetPending(e, catId)) continue;

        if (e.status === 'claimed' || e.status === 'processing') {
          // Use processingStartedAt (when the entry actually began processing),
          // NOT createdAt (when it was enqueued). An entry may sit queued for a
          // long time before being picked up — using createdAt would falsely
          // expire it the moment it starts processing. (P1 fix per codex review)
          const processingAge = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (processingAge < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.info(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  owner: e.owner,
                },
              },
              '[DIAG] hasActiveOrQueuedAgentForCat hit',
            );
            return true;
          }
          // Stale processing — zombie defense
          this.log?.warn(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                processingAgeMs: processingAge,
                owner: e.owner,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat: ignoring stale processing entry (zombie defense)',
          );
          continue;
        }

        if (e.status === 'queued') {
          this.log?.info(
            {
              threadId,
              catId,
              matchedEntry: {
                entryId: e.id,
                status: e.status,
                queuedAgeMs: now - e.enqueuedAt,
                owner: e.owner,
              },
            },
            '[DIAG] hasActiveOrQueuedAgentForCat hit',
          );
          return true;
        }
      }
    }
    return false;
  }

  /** Check for any queued/processing entry targeting a cat, optionally narrowed by source. */
  hasPendingForCat(
    threadId: string,
    catId: string,
    opts?: {
      excludeEntryId?: string;
      userId?: string;
      sources?: Array<ReturnType<typeof queueEntrySource>>;
      sourceCategories?: NonNullable<QueueEntry['sourceCategory']>[];
      continuationKey?: string;
    },
  ): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (opts?.excludeEntryId && e.id === opts.excludeEntryId) continue;
        if (opts?.userId && queueEntryOwnerId(e) !== opts.userId) continue;
        if (!isQueueTargetPending(e, catId)) continue;
        if (opts?.sources && !opts.sources.includes(queueEntrySource(e))) continue;
        if (opts?.sourceCategories) {
          if (!e.sourceCategory || !opts.sourceCategories.includes(e.sourceCategory)) continue;
        }
        if (opts?.continuationKey !== undefined && e.payload.sourceId !== opts.continuationKey) continue;

        if (e.status === 'queued') {
          return true;
        }

        if (e.status === 'claimed' || e.status === 'processing') {
          const processingAge = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (processingAge >= InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) {
            this.log?.warn(
              {
                threadId,
                catId,
                matchedEntry: {
                  entryId: e.id,
                  status: e.status,
                  processingAgeMs: processingAge,
                  owner: e.owner,
                },
              },
              '[DIAG] hasPendingForCat: ignoring stale processing entry (zombie defense)',
            );
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  /** F122B: Mark a specific entry as processing by ID (cross-user). */
  collectCompatibleConversationPrefix(
    head: QueueEntry | null | undefined,
    resolution?: {
      readonly routingClass: 'explicit' | 'targetless';
      readonly requestedTargets: readonly string[];
      readonly resolvedTargets: readonly string[];
    },
  ): QueueEntry[] {
    if (
      !head ||
      head.kind !== 'conversation_input' ||
      (resolution?.resolvedTargets ?? queueEntryTargetCats(head)).length === 0 ||
      head.position !== undefined ||
      head.delivery.steerRequestedAt !== undefined
    ) {
      return [];
    }

    const queued: QueueEntry[] = [];
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, head.threadId)) continue;
      queued.push(...q.filter((entry) => entry.status === 'queued' && entry.id !== head.id));
    }
    queued.sort(InvocationQueue.compareEntries);

    const headTargets = sorted([...(resolution?.requestedTargets ?? queueEntryTargetCats(head))]);
    const routingClass = resolution?.routingClass ?? 'explicit';
    const prefix: QueueEntry[] = [];
    for (const candidate of queued) {
      if (
        candidate.kind !== 'conversation_input' ||
        queueEntryOwnerId(candidate) !== queueEntryOwnerId(head) ||
        candidate.execution.intent !== head.execution.intent ||
        candidate.execution.ownerAuthProvenance !== head.execution.ownerAuthProvenance ||
        candidate.position !== undefined ||
        candidate.delivery.steerRequestedAt !== undefined ||
        (routingClass === 'targetless'
          ? candidate.target.kind !== 'unassigned'
          : !arraysEqual(sorted(queueEntryTargetCats(candidate)), headTargets)) ||
        (routingClass === 'explicit' &&
          queueEntryTargetCats(candidate).some((catId) => !isOrdinaryQueueTargetEligible(candidate, catId)))
      ) {
        break;
      }
      prefix.push(structuredClone(candidate));
    }
    return prefix;
  }

  /** #555: Whether a specific cat has any queued or processing entries in this thread (any source).
   *  Queued entries remain valid pending work regardless of age; only stale processing
   *  entries are ignored to prevent zombie entries from permanently blocking a cat. */
  hasQueuedOrProcessingForCat(threadId: string, catId: string): boolean {
    const now = Date.now();
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      for (const e of q) {
        if (!isQueueTargetPending(e, catId)) continue;
        if (e.status === 'queued') {
          return true;
        }
        if (e.status === 'claimed' || e.status === 'processing') {
          const age = now - (e.processingStartedAt ?? e.claimedAt ?? e.enqueuedAt);
          if (age < InvocationQueue.STALE_PROCESSING_THRESHOLD_MS) return true;
        }
      }
    }
    return false;
  }

  /** Durable work remains thread-visible until an explicit admission or terminal transition removes it. */
  hasQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((entry) => entry.status === 'queued')) return true;
    }
    return false;
  }

  /** Whether ordinary scheduling has at least one queued row to select. */
  hasOrdinaryEligibleQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (
        q.some(
          (entry) =>
            entry.status === 'queued' &&
            (entry.target.kind === 'unassigned' || isOrdinaryQueueTargetEligible(entry, entry.target.catId)),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Whether Queue still owns queued work for this thread. */
  hasDispatchableQueuedForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((e) => e.status === 'queued')) return true;
    }
    return false;
  }

  /** Whether a public conversation input is waiting; private/wake rows do not drive text-scan fairness. */
  hasQueuedConversationInputsForThread(threadId: string): boolean {
    for (const q of this.queues.values()) {
      if (!this.queueMatchesThread(q, threadId)) continue;
      if (q.some((entry) => entry.status === 'queued' && entry.kind === 'conversation_input')) return true;
    }
    return false;
  }

  // ── Internal helpers ──

  private findEntry(threadId: string, userId: string, entryId: string): QueueEntry | undefined {
    const q = this.queues.get(this.scopeKey(threadId, userId));
    return q?.find((e) => e.id === entryId);
  }
}

/** Sort a string array (returns new array). */
function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

/** Compare two sorted string arrays for equality. */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
