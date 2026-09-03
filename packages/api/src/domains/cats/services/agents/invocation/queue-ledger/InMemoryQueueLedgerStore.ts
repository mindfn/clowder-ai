import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerClaimResult,
  type QueueLedgerCommitMode,
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTransitionResult,
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';

export class InMemoryQueueLedgerStore implements QueueLedgerStore {
  private readonly rows = new Map<string, QueueLedgerEntry[]>();
  private readonly terminalRows = new Map<string, Map<string, QueueLedgerEntry>>();
  private readonly messageRows = new Map<string, Map<string, Set<string>>>();

  private indexEntries(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.messageRows.get(threadId) ?? new Map<string, Set<string>>();
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId) ?? new Set<string>();
      entryIds.add(entry.id);
      threadIndex.set(messageId, entryIds);
    }
    if (threadIndex.size > 0) this.messageRows.set(threadId, threadIndex);
  }

  private unindexEntries(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const threadIndex = this.messageRows.get(threadId);
    if (!threadIndex) return;
    for (const entry of entries) {
      const messageId = entry.payload.messageId;
      if (!messageId) continue;
      const entryIds = threadIndex.get(messageId);
      entryIds?.delete(entry.id);
      if (entryIds?.size === 0) threadIndex.delete(messageId);
    }
    if (threadIndex.size === 0) this.messageRows.delete(threadId);
  }

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
    const terminal = this.terminalRows.get(threadId);
    const existing = entries.map(
      (entry) => current.find((candidate) => candidate.id === entry.id) ?? terminal?.get(entry.id),
    );
    const existingEntries = existing.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (existingEntries.length === entries.length) {
      return existingEntries.every((entry, index) => {
        const input = entries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
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
    this.indexEntries(threadId, inserted);
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
    const removed = current.filter((entry) => ids.has(entry.id));
    if (remaining.length === 0) this.rows.delete(threadId);
    else this.rows.set(threadId, remaining);
    this.unindexEntries(threadId, removed);
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    return (this.rows.get(threadId) ?? []).map(cloneQueueLedgerEntry);
  }

  async listAll(threadId: string): Promise<QueueLedgerEntry[]> {
    return [...(this.rows.get(threadId) ?? []), ...[...(this.terminalRows.get(threadId)?.values() ?? [])]].map(
      cloneQueueLedgerEntry,
    );
  }

  async getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>> {
    const grouped = new Map<string, QueueLedgerEntry[]>();
    const threadIndex = this.messageRows.get(threadId);
    if (!threadIndex) return grouped;
    for (const messageId of new Set(messageIds)) {
      const entryIds = threadIndex.get(messageId);
      if (!entryIds) continue;
      const entries: QueueLedgerEntry[] = [];
      for (const entryId of entryIds) {
        const entry = this.getNow(threadId, entryId);
        if (!entry) throw new Error(`queue message index references missing row: ${entryId}`);
        if (entry.payload.messageId !== messageId) {
          throw new Error(`queue message index identity mismatch: ${messageId}:${entryId}`);
        }
        entries.push(entry);
      }
      grouped.set(messageId, entries);
    }
    return grouped;
  }

  async listThreadIds(): Promise<string[]> {
    return [...this.rows.keys()].sort();
  }

  async get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    return this.getNow(threadId, entryId);
  }

  getNow(threadId: string, entryId: string): QueueLedgerEntry | null {
    const entry =
      this.rows.get(threadId)?.find((candidate) => candidate.id === entryId) ??
      this.terminalRows.get(threadId)?.get(entryId);
    return entry ? cloneQueueLedgerEntry(entry) : null;
  }

  async claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    return this.claimPrefix(threadId, [entryId], claimId, claimedAt, bindTargetCatId, steerRequestedAt);
  }

  async claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    if (entryIds.length === 0 || !claimId || !Number.isFinite(claimedAt)) throw new Error('invalid queue claim');
    const current = this.rows.get(threadId);
    if (!current) return { outcome: 'not_found' };
    const selected = entryIds.map((id) => current.find((entry) => entry.id === id));
    const selectedEntries = selected.filter((entry): entry is QueueLedgerEntry => entry !== undefined);
    if (selectedEntries.length !== selected.length) return { outcome: 'not_found' };
    if (selectedEntries.some((entry) => entry.status !== 'queued')) return { outcome: 'state_changed' };
    if (
      bindTargetCatId &&
      selectedEntries.some((entry) => entry.target.kind === 'cat' && entry.target.catId !== bindTargetCatId)
    ) {
      return { outcome: 'state_changed' };
    }
    for (const entry of selectedEntries) {
      entry.status = 'claimed';
      entry.claimId = claimId;
      entry.claimedAt = claimedAt;
      if (bindTargetCatId) entry.target = { kind: 'cat', catId: bindTargetCatId };
      if (steerRequestedAt !== undefined) entry.delivery.steerRequestedAt = steerRequestedAt;
    }
    return { outcome: 'claimed', claimId, entries: selectedEntries.map(cloneQueueLedgerEntry) };
  }

  async commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
    replacement?: QueueLedgerEntry,
  ): Promise<QueueLedgerTransitionResult> {
    const current = this.rows.get(threadId);
    const index = current?.findIndex((entry) => entry.id === entryId) ?? -1;
    if (!current || index < 0) return { outcome: 'not_found' };
    const entry = current[index];
    if (!entry) return { outcome: 'not_found' };
    if (mode === 'queued' || mode === 'processing') {
      return this.commitClaimedState(current, index, entry, claimId, mode, at, replacement);
    }
    return this.commitTerminalState(threadId, current, index, entry, claimId, mode, at, replacement);
  }

  private commitClaimedState(
    current: QueueLedgerEntry[],
    index: number,
    entry: QueueLedgerEntry,
    claimId: string,
    mode: 'queued' | 'processing',
    at: number,
    replacement?: QueueLedgerEntry,
  ): QueueLedgerTransitionResult {
    if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
    const next = replacement ? cloneQueueLedgerEntry(replacement) : cloneQueueLedgerEntry(entry);
    if (next.id !== entry.id || next.threadId !== entry.threadId) throw new Error('Queue commit identity mismatch');
    next.status = mode;
    delete next.claimId;
    delete next.claimedAt;
    if (mode === 'processing') next.processingStartedAt = at;
    else delete next.processingStartedAt;
    assertQueueLedgerEntry(next);
    current[index] = next;
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(next) };
  }

  private commitTerminalState(
    threadId: string,
    current: QueueLedgerEntry[],
    index: number,
    entry: QueueLedgerEntry,
    claimId: string,
    mode: 'terminal' | 'withdrawn',
    at: number,
    replacement?: QueueLedgerEntry,
  ): QueueLedgerTransitionResult {
    if (mode === 'withdrawn') {
      if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
    } else if (entry.status !== 'processing') return { outcome: 'state_changed' };
    const terminal = replacement ? cloneQueueLedgerEntry(replacement) : cloneQueueLedgerEntry(entry);
    if (terminal.id !== entry.id || terminal.threadId !== entry.threadId) {
      throw new Error('Queue commit identity mismatch');
    }
    terminal.status = 'terminal';
    terminal.terminalAt = at;
    if (mode === 'withdrawn') {
      terminal.delivery.terminalOutcome = 'withdrawn';
      terminal.delivery.failedAt = at;
      terminal.delivery.failureReason = 'source_withdrawn';
    }
    delete terminal.claimId;
    delete terminal.claimedAt;
    assertQueueLedgerEntry(terminal);
    current.splice(index, 1);
    if (current.length === 0) this.rows.delete(threadId);
    const threadTerminalRows = this.terminalRows.get(threadId) ?? new Map<string, QueueLedgerEntry>();
    threadTerminalRows.set(entry.id, terminal);
    this.terminalRows.set(threadId, threadTerminalRows);
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(terminal) };
  }

  async restore(
    threadId: string,
    entryId: string,
    claimId: string,
    restoreUnassignedTarget = false,
  ): Promise<QueueLedgerTransitionResult> {
    const entry = this.rows.get(threadId)?.find((candidate) => candidate.id === entryId);
    if (!entry) return { outcome: 'not_found' };
    if (entry.status !== 'claimed' || entry.claimId !== claimId) return { outcome: 'state_changed' };
    entry.status = 'queued';
    delete entry.claimId;
    delete entry.claimedAt;
    delete entry.delivery.steerRequestedAt;
    if (restoreUnassignedTarget) entry.target = { kind: 'unassigned' };
    return { outcome: 'updated', entry: cloneQueueLedgerEntry(entry) };
  }
}
