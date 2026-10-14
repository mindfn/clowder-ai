export interface QueueSourceMutationWatch {
  isCurrent(): boolean;
  waitForSettled(): Promise<void>;
  release(): void;
}

interface WatchState {
  readonly messageIds: readonly string[];
  stale: boolean;
  released: boolean;
}

/**
 * Process-local publication fence for the process-local InvocationQueue.
 *
 * A watch spans asynchronous source reads and is checked immediately before a
 * synchronous Queue publication. Canonical MessageStore mutations invalidate
 * every overlapping watch both when they start and when they settle, including
 * watches registered while an asynchronous Redis mutation is in flight.
 */
export class QueueSourceMutationWatchRegistry {
  private readonly activeMutationCountByMessageId = new Map<string, number>();
  private readonly mutationSettlementWaitersByMessageId = new Map<string, Set<() => void>>();
  private readonly watchersByMessageId = new Map<string, Set<WatchState>>();

  watch(messageIds: readonly string[]): QueueSourceMutationWatch {
    const uniqueMessageIds = [...new Set(messageIds.filter(Boolean))];
    const state: WatchState = {
      messageIds: uniqueMessageIds,
      stale: uniqueMessageIds.some((messageId) => (this.activeMutationCountByMessageId.get(messageId) ?? 0) > 0),
      released: false,
    };
    for (const messageId of uniqueMessageIds) {
      const watchers = this.watchersByMessageId.get(messageId) ?? new Set<WatchState>();
      watchers.add(state);
      this.watchersByMessageId.set(messageId, watchers);
    }
    return {
      isCurrent: () => !state.released && !state.stale,
      waitForSettled: () => this.waitForSettled(uniqueMessageIds),
      release: () => this.release(state),
    };
  }

  beginMutation(messageId: string): () => void {
    this.invalidate(messageId);
    this.activeMutationCountByMessageId.set(messageId, (this.activeMutationCountByMessageId.get(messageId) ?? 0) + 1);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = (this.activeMutationCountByMessageId.get(messageId) ?? 1) - 1;
      if (remaining > 0) this.activeMutationCountByMessageId.set(messageId, remaining);
      else {
        this.activeMutationCountByMessageId.delete(messageId);
        const waiters = this.mutationSettlementWaitersByMessageId.get(messageId);
        this.mutationSettlementWaitersByMessageId.delete(messageId);
        for (const resolve of waiters ?? []) resolve();
      }
      this.invalidate(messageId);
    };
  }

  private waitForSettled(messageIds: readonly string[]): Promise<void> {
    const waits = messageIds.map((messageId) => {
      if ((this.activeMutationCountByMessageId.get(messageId) ?? 0) === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = this.mutationSettlementWaitersByMessageId.get(messageId) ?? new Set<() => void>();
        waiters.add(resolve);
        this.mutationSettlementWaitersByMessageId.set(messageId, waiters);
      });
    });
    return Promise.all(waits).then(() => undefined);
  }

  private invalidate(messageId: string): void {
    for (const watcher of this.watchersByMessageId.get(messageId) ?? []) watcher.stale = true;
  }

  private release(state: WatchState): void {
    if (state.released) return;
    state.released = true;
    for (const messageId of state.messageIds) {
      const watchers = this.watchersByMessageId.get(messageId);
      if (!watchers) continue;
      watchers.delete(state);
      if (watchers.size === 0) this.watchersByMessageId.delete(messageId);
    }
  }
}
