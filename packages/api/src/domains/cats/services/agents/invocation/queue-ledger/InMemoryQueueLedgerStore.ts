import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerClaimResult,
  type QueueLedgerCommitMode,
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTransitionResult,
} from './QueueLedger.js';

function equalEntry(a: QueueLedgerEntry, b: QueueLedgerEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class InMemoryQueueLedgerStore implements QueueLedgerStore {
  private readonly rows = new Map<string, QueueLedgerEntry[]>();

  enqueueNow(entries: readonly QueueLedgerEntry[], maxQueuedUserEntries?: number): QueueLedgerEnqueueResult {
    if (entries.length === 0) throw new Error('queue ledger enqueue requires at least one row');
    for (const entry of entries) assertQueueLedgerEntry(entry);
    const threadId = entries[0]?.threadId;
    if (entries.some((entry) => entry.threadId !== threadId))
      throw new Error('queue ledger enqueue must be one thread');
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error('queue ledger enqueue ids must be unique');
    }
    const current = this.rows.get(threadId) ?? [];
    const existing = entries.map((entry) => current.find((candidate) => candidate.id === entry.id));
    const existingEntries = existing.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (existingEntries.length === entries.length) {
      return existingEntries.every((entry, index) => {
        const input = entries[index];
        return input !== undefined && equalEntry(entry, input);
      })
        ? { outcome: 'replayed', entries: existingEntries.map(cloneQueueLedgerEntry) }
        : { outcome: 'conflict', entries: [] };
    }
    if (existing.some(Boolean)) return { outcome: 'conflict', entries: [] };
    if (maxQueuedUserEntries !== undefined) {
      const queuedUserSources = new Set(
        current
          .filter((entry) => entry.from.kind === 'user' && entry.status === 'queued')
          .map((entry) => entry.payload.sourceId),
      );
      const incomingUserSources = new Set(
        entries.filter((entry) => entry.from.kind === 'user').map((entry) => entry.payload.sourceId),
      );
      if (new Set([...queuedUserSources, ...incomingUserSources]).size > maxQueuedUserEntries) {
        return { outcome: 'full', entries: [] };
      }
    }
    const inserted = entries.map(cloneQueueLedgerEntry);
    current.push(...inserted);
    this.rows.set(threadId, current);
    return { outcome: 'enqueued', entries: inserted.map(cloneQueueLedgerEntry) };
  }

  async enqueue(
    entries: readonly QueueLedgerEntry[],
    maxQueuedUserEntries?: number,
  ): Promise<QueueLedgerEnqueueResult> {
    return this.enqueueNow(entries, maxQueuedUserEntries);
  }

  /** Roll back only rows created by the same synchronous memory admission. */
  removeEnqueuedNow(entries: readonly QueueLedgerEntry[]): void {
    if (entries.length === 0) return;
    const threadId = entries[0]?.threadId;
    const current = threadId ? this.rows.get(threadId) : undefined;
    if (!current) return;
    const ids = new Set(entries.map((entry) => entry.id));
    const remaining = current.filter((entry) => !ids.has(entry.id));
    if (remaining.length === 0) this.rows.delete(threadId);
    else this.rows.set(threadId, remaining);
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    return (this.rows.get(threadId) ?? []).map(cloneQueueLedgerEntry);
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.rows.keys()].sort();
  }

  async get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    return entry ? cloneQueueLedgerEntry(entry) : null;
  }

  async claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
  ): Promise<QueueLedgerClaimResult> {
    const result = await this.claimPrefix(threadId, [entryId], claimId, claimedAt);
    if (result.outcome !== 'claimed' || !bindTargetCatId) return result;
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    if (!entry) return { outcome: 'not_found' };
    if (entry.target.kind === 'cat' && entry.target.catId !== bindTargetCatId) {
      await this.restore(threadId, entryId, claimId);
      return { outcome: 'state_changed' };
    }
    entry.target = { kind: 'cat', catId: bindTargetCatId };
    return { outcome: 'claimed', claimId, entries: [cloneQueueLedgerEntry(entry)] };
  }

  async claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
  ): Promise<QueueLedgerClaimResult> {
    if (entryIds.length === 0 || !claimId || !Number.isFinite(claimedAt)) throw new Error('invalid queue claim');
    const current = this.rows.get(threadId);
    if (!current) return { outcome: 'not_found' };
    const selected = entryIds.map((id) => current.find((entry) => entry.id === id));
    const selectedEntries = selected.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (selectedEntries.length !== selected.length) return { outcome: 'not_found' };
    if (selectedEntries.some((entry) => entry.status !== 'queued')) return { outcome: 'state_changed' };
    for (const entry of selectedEntries) {
      entry.status = 'claimed';
      entry.claimId = claimId;
      entry.claimedAt = claimedAt;
    }
    return { outcome: 'claimed', claimId, entries: selectedEntries.map(cloneQueueLedgerEntry) };
  }

  async commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
  ): Promise<QueueLedgerTransitionResult> {
    const current = this.rows.get(threadId);
    const index = current?.findIndex((entry) => entry.id === entryId) ?? -1;
    if (!current || index < 0) return { outcome: 'not_found' };
    const entry = current[index];
    if (!entry) return { outcome: 'not_found' };
    if (mode === 'withdrawn') {
      if (entry.status !== 'queued') return { outcome: 'state_changed' };
      current.splice(index, 1);
      return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
    }
    if (mode === 'processing') {
      if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
      entry.status = 'processing';
      entry.processingStartedAt = at;
      delete entry.claimId;
      delete entry.claimedAt;
      return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
    }
    if (entry.status !== 'processing') return { outcome: 'state_changed' };
    current.splice(index, 1);
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
  }

  async restore(threadId: string, entryId: string, claimId: string): Promise<QueueLedgerTransitionResult> {
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    if (!entry) return { outcome: 'not_found' };
    if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
    entry.status = 'queued';
    delete entry.claimId;
    delete entry.claimedAt;
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
  }
}
