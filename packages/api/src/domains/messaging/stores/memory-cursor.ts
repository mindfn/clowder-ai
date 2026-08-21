/** In-memory subscription cursor and frozen snapshot state. */

import type { CursorStore, SnapshotViewRecord, SubscriptionRecord } from './ports.js';

export class MemoryCursorStore implements CursorStore {
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly subscriptionByHandle = new Map<string, string>();

  private static key(pluginInstanceId: string, subscriptionId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(subscriptionId)}`;
  }

  private static handleKey(pluginInstanceId: string, handleId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(handleId)}`;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(
      MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId),
      record.subscriptionId,
    );
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId)) ?? null;
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = this.subscriptionByHandle.get(MemoryCursorStore.handleKey(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId));
    return record && record.revokedAt === undefined ? record : null;
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    // Deliberately no await: this check+write block is atomic in one JS turn.
    const handleKey = MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId);
    const existingId = this.subscriptionByHandle.get(handleKey);
    if (existingId) {
      const existing = this.subs.get(MemoryCursorStore.key(record.pluginInstanceId, existingId));
      if (existing && existing.revokedAt === undefined) return existing;
    }
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(handleKey, record.subscriptionId);
    return record;
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (record && sequence > record.ackedSequence) {
      this.subs.set(key, { ...record, ackedSequence: sequence });
    }
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (record && sequence > record.lastDeliveredSequence) {
      this.subs.set(key, { ...record, lastDeliveredSequence: sequence });
    }
  }

  async createOrGetSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshot: SnapshotViewRecord,
  ): Promise<SnapshotViewRecord | null> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record || record.revokedAt !== undefined) return null;
    if (record.snapshotView) return structuredClone(record.snapshotView);
    const frozen = structuredClone(snapshot);
    this.subs.set(key, { ...record, snapshotView: frozen, lastSnapshotCompletion: undefined });
    return structuredClone(frozen);
  }

  async consumeSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expected: { readonly offset: number; readonly tokenId?: string },
    next: { readonly offset: number; readonly tokenId?: string; readonly traversalComplete: boolean },
  ): Promise<boolean> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    const snapshot = record?.snapshotView;
    if (
      !record ||
      record.revokedAt !== undefined ||
      !snapshot ||
      snapshot.snapshotId !== snapshotId ||
      snapshot.traversalComplete ||
      snapshot.nextOffset !== expected.offset ||
      snapshot.nextPageTokenId !== expected.tokenId
    ) {
      return false;
    }
    this.subs.set(key, {
      ...record,
      snapshotView: {
        ...snapshot,
        nextOffset: next.offset,
        nextPageTokenId: next.tokenId,
        traversalComplete: next.traversalComplete,
      },
    });
    return true;
  }

  async ackSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    headSequence: number,
  ): Promise<'applied' | 'replayed' | 'rejected'> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record || record.revokedAt !== undefined) return 'rejected';
    if (
      record.lastSnapshotCompletion?.snapshotId === snapshotId &&
      record.lastSnapshotCompletion.headSequence === headSequence
    ) {
      return 'replayed';
    }
    if (
      record.snapshotView?.snapshotId !== snapshotId ||
      record.snapshotView.headSequence !== headSequence ||
      !record.snapshotView.traversalComplete
    ) {
      return 'rejected';
    }
    this.subs.set(key, {
      ...record,
      ackedSequence: Math.max(record.ackedSequence, headSequence),
      lastDeliveredSequence: Math.max(record.lastDeliveredSequence, headSequence),
      snapshotView: undefined,
      lastSnapshotCompletion: { snapshotId, headSequence },
    });
    return 'applied';
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
