/**
 * Plugin Messaging — in-memory store implementations (K-1 / F258)
 *
 * Dev/test semantics: process-lifetime state (consistent with the in-memory
 * MessageStore — KL-2 in the plan). Redis implementations carry production
 * durability. Atomicity: single-threaded event loop makes check-then-act
 * inside one synchronous block atomic.
 */

import type {
  CursorStore,
  HandleRecord,
  HandleStore,
  LedgerClaimResult,
  LedgerStore,
  SubscriptionRecord,
} from './ports.js';

type LedgerEntry =
  | { readonly status: 'inflight'; readonly expiresAt: number }
  | { readonly status: 'settled'; readonly receipt: unknown; readonly expiresAt: number };

export class MemoryLedgerStore implements LedgerStore {
  private readonly entries = new Map<string, LedgerEntry>();

  async claim(key: string, claimTtlMs: number): Promise<LedgerClaimResult> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      if (entry.status === 'settled') return { status: 'settled', receipt: entry.receipt };
      return { status: 'inflight' };
    }
    this.entries.set(key, { status: 'inflight', expiresAt: now + claimTtlMs });
    return { status: 'new' };
  }

  async settle(key: string, receipt: unknown, retentionMs: number): Promise<void> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.status === 'settled' && entry.expiresAt > now) return; // first receipt sticks
    this.entries.set(key, { status: 'settled', receipt, expiresAt: now + retentionMs });
  }

  async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.status === 'settled') return; // settled is sticky
    this.entries.delete(key);
  }
}

export class MemoryHandleStore implements HandleStore {
  private readonly records = new Map<string, HandleRecord>();

  async put(record: HandleRecord): Promise<void> {
    this.records.set(record.handleId, record);
  }

  async get(handleId: string): Promise<HandleRecord | null> {
    return this.records.get(handleId) ?? null;
  }

  async revoke(handleId: string, revokedAt: number): Promise<boolean> {
    const record = this.records.get(handleId);
    if (!record) return false;
    if (record.revokedAt === undefined) {
      this.records.set(handleId, { ...record, revokedAt });
    }
    return true;
  }
}

export class MemoryCursorStore implements CursorStore {
  private readonly subs = new Map<string, SubscriptionRecord>();

  private static key(pluginInstanceId: string, subscriptionId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(subscriptionId)}`;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId)) ?? null;
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    for (const record of this.subs.values()) {
      if (record.pluginInstanceId === pluginInstanceId && record.handleId === handleId && !record.revokedAt) {
        return record;
      }
    }
    return null;
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record) return;
    if (sequence > record.ackedSequence) {
      this.subs.set(key, { ...record, ackedSequence: sequence });
    }
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record) return;
    if (sequence > record.lastDeliveredSequence) {
      this.subs.set(key, { ...record, lastDeliveredSequence: sequence });
    }
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    let count = 0;
    for (const [key, record] of this.subs.entries()) {
      if (record.handleId === handleId && record.revokedAt === undefined) {
        this.subs.set(key, { ...record, revokedAt });
        count += 1;
      }
    }
    return count;
  }
}
