/**
 * Plugin Messaging — in-memory store implementations (K-1 / F258)
 *
 * Dev/test semantics: process-lifetime state (consistent with the in-memory
 * MessageStore — KL-2 in the plan). Redis implementations carry production
 * durability. Atomicity: single-threaded event loop makes check-then-act
 * inside one synchronous block atomic.
 */

import type { LedgerClaimResult, LedgerStore } from './ports.js';

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
