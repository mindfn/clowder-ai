import { randomUUID } from 'node:crypto';

import type { CatId } from '@cat-cafe/shared';

import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueuedMessageCustody } from '../../stores/ports/queued-message-custody.js';

import type { InvocationQueue, QueuedHandledResult, QueueEntry } from './InvocationQueue.js';
import {
  projectUnconsumedQueueCarrier,
  queueCarrierMessageIds,
  readQueueCarrierMessages,
} from './QueueCarrierSourceProjection.js';
import {
  createCrossThreadQueueEntryFromCustody,
  createInitialFanoutQueuedMessageCustody,
  createInitialQueuedMessageCustody,
  type QueuedMessageCustodyCoordinator,
  readCompleteCrossThreadQueueCarrierGroups,
} from './QueuedMessageCustodyCoordinator.js';

export function queueSourceCustodyAdmissionId(sourceMessageId: string): string {
  return `queue-source:${sourceMessageId}`;
}

interface StagedQueueSourceCarrier {
  staged: QueueEntry;
  rollback: { kind: 'remove' } | { kind: 'restore'; snapshot: QueueEntry };
}

type QueueSourcePersistenceOutcome = 'committed' | 'reused_durable_carrier';

export type QueueHandledRestoreOutcome = 'restored' | 'superseded' | 'state_changed';

const sourceLocksByQueue = new WeakMap<object, Map<string, Promise<void>>>();
export class QueueSourceCustodyAdmissionService {
  private readonly sourceLocks: Map<string, Promise<void>>;
  private readonly inFlightExactAdmissions = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      queue: InvocationQueue;
      messageStore: IMessageStore;
      queueCustodyCoordinator?: Pick<QueuedMessageCustodyCoordinator, 'transferEntryCustody'>;
    },
  ) {
    const existing = sourceLocksByQueue.get(deps.queue);
    if (existing) {
      this.sourceLocks = existing;
    } else {
      this.sourceLocks = new Map<string, Promise<void>>();
      sourceLocksByQueue.set(deps.queue, this.sourceLocks);
    }
  }

  /** Admit one ordinary Queue source while preserving the legacy call surface. */
  admitDeferred(
    entry: QueueEntry,
    sourceMessageId: string,
    deduped = false,
    rollbackSnapshot?: QueueEntry,
  ): Promise<void> {
    return this.admitEntries([entry], sourceMessageId, [
      rollbackSnapshot
        ? { kind: 'restore', snapshot: rollbackSnapshot }
        : deduped
          ? { kind: 'restore', snapshot: this.requireCurrent(entry) }
          : { kind: 'remove' },
    ]);
  }

  /**
   * Admit every occupied/fairness target of one persisted A2A source as one
   * per-target fan-out custody group. The supplied entries must already carry
   * the deterministic process-local fence assigned at enqueue.
   */
  admitDeferredBatch(entries: readonly QueueEntry[], sourceMessageId: string): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    return this.admitEntries(
      entries,
      sourceMessageId,
      entries.map(() => ({ kind: 'remove' as const })),
    );
  }

  /** Remove not-yet-persisted route carriers when a later sibling enqueue fails. */
  discardDeferredBatch(entries: readonly QueueEntry[], sourceMessageId: string): void {
    const admissionId = queueSourceCustodyAdmissionId(sourceMessageId);
    for (const entry of [...entries].reverse()) {
      const current = this.deps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
      if (!current) continue;
      if (current.queueCustodyAdmissionId !== admissionId) {
        throw new Error(`Queue source admission lost its unpublished carrier ${entry.id}`);
      }
      if (!this.deps.queue.removeEntrySnapshotIfUnchanged(current, admissionId)) {
        throw new Error(`Queue source admission could not discard carrier ${entry.id}`);
      }
    }
  }

  /**
   * Restore a tentatively consumed carrier only from current source truth.
   * Source locks make the durable projection check and Queue CAS one boundary
   * with connector/A2A recovery, so a late terminal cannot resurrect a foreign
   * carrier after recovery rebound the source to a replacement.
   */
  restoreHandledCarrier(result: QueuedHandledResult): Promise<QueueHandledRestoreOutcome> {
    const snapshot = result.entrySnapshot;
    const sourceMessageIds = queueCarrierMessageIds(snapshot);
    return this.withSourceLocks(sourceMessageIds, async () => {
      while (true) {
        const watch = this.deps.messageStore.watchQueueSourceMutations(sourceMessageIds);
        let retryAfterMutation = Promise.resolve();
        try {
          const messages = await readQueueCarrierMessages(snapshot, this.deps.messageStore);
          if (watch.isCurrent()) {
            const replacement = projectUnconsumedQueueCarrier(snapshot, messages);
            if (!replacement) return 'superseded';
            // No await may appear between this fence and the process-local Queue CAS.
            // A canonical source mutation either invalidated the watch already or
            // linearizes after this synchronous publication.
            if (watch.isCurrent()) {
              return this.deps.queue.restoreQueuedHandledResult(result, replacement) ? 'restored' : 'state_changed';
            }
          }
          retryAfterMutation = watch.waitForSettled();
        } finally {
          watch.release();
        }
        await retryAfterMutation;
      }
    });
  }

  private requireCurrent(entry: QueueEntry): QueueEntry {
    const current = this.deps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    if (!current) throw new Error(`Queue source carrier disappeared before admission: ${entry.id}`);
    return current;
  }

  private admitEntries(
    entries: readonly QueueEntry[],
    sourceMessageId: string,
    rollbackPlans: readonly StagedQueueSourceCarrier['rollback'][],
  ): Promise<void> {
    if (entries.length === 0 || entries.length !== rollbackPlans.length) {
      throw new Error('Queue source admission requires a non-empty, fully planned carrier group');
    }
    const exactAdmissionKey = JSON.stringify([sourceMessageId, [...entries.map((entry) => entry.id)].sort()]);
    const inFlight = this.inFlightExactAdmissions.get(exactAdmissionKey);
    if (inFlight) return inFlight;

    const provisionalAdmissionId = queueSourceCustodyAdmissionId(sourceMessageId);
    const operationAdmissionId = `${provisionalAdmissionId}:operation:${randomUUID()}`;
    const staged: StagedQueueSourceCarrier[] = [];
    try {
      for (const [index, entry] of entries.entries()) {
        staged.push({
          staged: this.stageEntry(entry, sourceMessageId, operationAdmissionId, provisionalAdmissionId),
          rollback: rollbackPlans[index]!,
        });
      }
    } catch (error) {
      this.rollbackStaged(staged, error);
      throw error;
    }

    const operation = this.withSourceLock(sourceMessageId, async () => {
      let outcome: QueueSourcePersistenceOutcome;
      try {
        outcome = await this.persistSourceCustody(
          staged.map((item) => item.staged),
          sourceMessageId,
        );
      } catch (error) {
        this.rollbackStaged(staged, error);
        throw error;
      }
      if (outcome === 'reused_durable_carrier') {
        this.rollbackStaged(staged);
        return;
      }
      try {
        const first = staged[0]!.staged;
        if (
          staged.some(({ staged: entry }) => entry.threadId !== first.threadId || entry.userId !== first.userId) ||
          !this.deps.queue.commitQueueCustodyAdmission(
            first.threadId,
            first.userId,
            operationAdmissionId,
            staged.map(({ staged: entry }) => entry.id),
          )
        ) {
          throw new Error(`Queue source admission changed before publish: ${sourceMessageId}`);
        }
      } catch (error) {
        this.rollbackStaged(staged, error);
        throw error;
      }
    });
    this.inFlightExactAdmissions.set(exactAdmissionKey, operation);
    void operation.then(
      () => this.deleteExactAdmission(exactAdmissionKey, operation),
      () => this.deleteExactAdmission(exactAdmissionKey, operation),
    );
    return operation;
  }

  private deleteExactAdmission(exactAdmissionKey: string, operation: Promise<void>): void {
    if (this.inFlightExactAdmissions.get(exactAdmissionKey) === operation) {
      this.inFlightExactAdmissions.delete(exactAdmissionKey);
    }
  }

  private stageEntry(
    entry: QueueEntry,
    sourceMessageId: string,
    operationAdmissionId: string,
    provisionalAdmissionId: string,
  ): QueueEntry {
    const current = this.requireCurrent(entry);
    if (current.messageId !== sourceMessageId && !current.mergedMessageIds.includes(sourceMessageId)) {
      throw new Error(`Queue source carrier does not contain message ${sourceMessageId}`);
    }
    const staged = this.deps.queue.stageQueueCustodyAdmission(
      current.threadId,
      current.userId,
      current.id,
      operationAdmissionId,
      provisionalAdmissionId,
    );
    if (!staged) throw new Error(`Queue source carrier could not be fenced: ${entry.id}`);
    return staged;
  }

  private async persistSourceCustody(
    entries: readonly QueueEntry[],
    sourceMessageId: string,
  ): Promise<QueueSourcePersistenceOutcome> {
    let source = await this.deps.messageStore.getById(sourceMessageId);
    if (!source) throw new Error(`Queue source message not found: ${sourceMessageId}`);

    if (!source.queueCustody) {
      const desired = createInitialSourceCustody(sourceMessageId, entries);
      const admitted = await this.deps.messageStore.admitQueueCustody(sourceMessageId, desired);
      if (admitted.kind === 'initialized' || admitted.kind === 'existing') {
        source = admitted.message;
      } else {
        source = await this.deps.messageStore.getById(sourceMessageId);
        if (!source?.queueCustody) {
          throw new Error(`Queue source custody admission failed for ${sourceMessageId}: ${admitted.kind}`);
        }
      }
    }

    if (exactSourceCustodyMatches(source, entries)) return 'committed';
    return this.resolveForeignCustody(source, entries, sourceMessageId);
  }

  private async resolveForeignCustody(
    source: StoredMessage,
    entries: readonly QueueEntry[],
    sourceMessageId: string,
  ): Promise<QueueSourcePersistenceOutcome> {
    const custody = source.queueCustody;
    if (source.deliveryStatus !== 'queued' || !custody || custody.status === 'terminal') {
      throw new Error(`Queue source has foreign custody: ${sourceMessageId}`);
    }
    const expectedByTarget = expectedCarrierByTarget(entries);
    const observedByTarget = new Map<CatId, string>();
    for (const targetCatId of expectedByTarget.keys()) {
      const observedEntryId =
        custody.carrierByTargetCatId?.[targetCatId]?.entryId ??
        (custody.carrierByTargetCatId
          ? undefined
          : custody.allTargetCats.includes(targetCatId)
            ? custody.entryId
            : undefined);
      if (!observedEntryId) throw new Error(`Queue source has incomplete per-target custody: ${sourceMessageId}`);
      observedByTarget.set(targetCatId, observedEntryId);
    }
    const foreignEntryIds = [
      ...new Set(
        [...observedByTarget].flatMap(([targetCatId, entryId]) =>
          expectedByTarget.get(targetCatId)?.id === entryId ? [] : [entryId],
        ),
      ),
    ];
    if (foreignEntryIds.length === 0) throw new Error(`Queue source custody identity mismatch: ${sourceMessageId}`);
    const ownerUserId = custody.ownerUserId ?? entries[0]!.userId;
    for (const entryId of foreignEntryIds) {
      if (this.deps.queue.getEntrySnapshotForUserById(ownerUserId, entryId)) {
        throw new Error(`Queue source is still owned by live Queue source carrier ${entryId}`);
      }
    }

    if (custody.carrierByTargetCatId) {
      const groups = await readCompleteCrossThreadQueueCarrierGroups(
        this.deps.messageStore,
        source.threadId,
        ownerUserId,
        foreignEntryIds,
      );
      for (const entryId of foreignEntryIds) {
        const group = groups.get(entryId) ?? [];
        if (!group.some((message) => message.id === sourceMessageId)) {
          throw new Error(`Queue source durable carrier group is incomplete: ${sourceMessageId}/${entryId}`);
        }
        this.deps.queue.restoreDurableEntry(createCrossThreadQueueEntryFromCustody(group, entryId));
      }
      return 'reused_durable_carrier';
    }

    if (entries.length !== 1 || foreignEntryIds.length !== 1 || !this.deps.queueCustodyCoordinator) {
      throw new Error(`Queue source has foreign custody: ${sourceMessageId}`);
    }
    const replacement = entries[0]!;
    await this.deps.queueCustodyCoordinator.transferEntryCustody(replacement, {
      kind: 'verified',
      previousEntryId: foreignEntryIds[0]!,
      replacementEntryId: replacement.id,
      sourceMessageId,
    });
    const rebound = await this.deps.messageStore.getById(sourceMessageId);
    if (!exactSourceCustodyMatches(rebound, entries)) {
      throw new Error(`Queue source replacement did not bind its exact carrier: ${sourceMessageId}`);
    }
    return 'committed';
  }

  private rollbackStaged(staged: readonly StagedQueueSourceCarrier[], cause?: unknown): void {
    for (const item of [...staged].reverse()) {
      const reverted =
        item.rollback.kind === 'remove'
          ? this.deps.queue.removeEntrySnapshotIfUnchanged(item.staged, item.staged.queueCustodyAdmissionId)
          : this.deps.queue.restoreEntrySnapshotIfUnchanged(
              item.staged,
              item.rollback.snapshot,
              item.staged.queueCustodyAdmissionId,
            );
      if (!reverted) throw new Error(`Queue source admission rollback lost carrier ${item.staged.id}`, { cause });
    }
  }

  private async withSourceLock<T>(sourceMessageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sourceLocks.get(sourceMessageId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.sourceLocks.set(sourceMessageId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sourceLocks.get(sourceMessageId) === tail) this.sourceLocks.delete(sourceMessageId);
    }
  }

  private async withSourceLocks<T>(sourceMessageIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(sourceMessageIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const sourceMessageId = ordered[index];
      return sourceMessageId === undefined
        ? operation()
        : this.withSourceLock(sourceMessageId, () => acquire(index + 1));
    };
    return acquire(0);
  }
}

function createInitialSourceCustody(sourceMessageId: string, entries: readonly QueueEntry[]): QueuedMessageCustody {
  const fanout = entries.every((entry) => entry.source === 'agent' && entry.sourceCategory === 'a2a');
  if (fanout) return createInitialFanoutQueuedMessageCustody(sourceMessageId, entries);
  if (entries.length !== 1) throw new Error('non-A2A Queue source admission requires one exact carrier');
  return createInitialQueuedMessageCustody(entries[0]!);
}

function expectedCarrierByTarget(entries: readonly QueueEntry[]): Map<CatId, QueueEntry> {
  const expected = new Map<CatId, QueueEntry>();
  for (const entry of entries) {
    for (const targetCatId of entry.targetCats as CatId[]) {
      if (expected.has(targetCatId)) throw new Error(`Queue source target has multiple carriers: ${targetCatId}`);
      expected.set(targetCatId, entry);
    }
  }
  return expected;
}

function exactSourceCustodyMatches(source: StoredMessage | null, entries: readonly QueueEntry[]): boolean {
  const custody = source?.queueCustody;
  if (source?.deliveryStatus !== 'queued' || !custody || custody.status === 'terminal') return false;
  for (const [targetCatId, entry] of expectedCarrierByTarget(entries)) {
    const durableEntryId =
      custody.carrierByTargetCatId?.[targetCatId]?.entryId ??
      (custody.carrierByTargetCatId
        ? undefined
        : custody.allTargetCats.includes(targetCatId)
          ? custody.entryId
          : undefined);
    if (durableEntryId !== entry.id) return false;
  }
  return true;
}
