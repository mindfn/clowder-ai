import type { RedisClient } from '@cat-cafe/shared/utils';
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
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  ENQUEUE_QUEUE_ROWS_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-scripts.js';

function hydrateQueueLedgerEntry(raw: string): QueueLedgerEntry {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('corrupt queue ledger row');
  const entry = parsed as QueueLedgerEntry;
  assertQueueLedgerEntry(entry);
  return entry;
}

function transitionResult(raw: unknown): QueueLedgerTransitionResult {
  if (!Array.isArray(raw)) throw new Error('invalid queue ledger transition reply');
  const outcome = Number(raw[0]);
  if (outcome === -1) return { outcome: 'not_found' };
  if (outcome === 0) return { outcome: 'state_changed' };
  if (outcome !== 1 || typeof raw[1] !== 'string') throw new Error('invalid queue ledger transition outcome');
  return { outcome: 'updated', entry: hydrateQueueLedgerEntry(raw[1]) };
}

export class RedisQueueLedgerStore implements QueueLedgerStore {
  constructor(private readonly redis: RedisClient) {}

  async enqueue(
    entries: readonly QueueLedgerEntry[],
    maxQueuedUserEntries?: number,
  ): Promise<QueueLedgerEnqueueResult> {
    if (entries.length === 0) throw new Error('queue ledger enqueue requires at least one row');
    for (const entry of entries) assertQueueLedgerEntry(entry);
    const first = entries[0];
    if (!first) throw new Error('queue ledger enqueue requires at least one row');
    const threadId = first.threadId;
    if (entries.some((entry) => entry.threadId !== threadId))
      throw new Error('queue ledger enqueue must be one thread');
    const serialized = entries.map((entry) => JSON.stringify(entry));
    const raw = Number(
      await this.redis.eval(
        ENQUEUE_QUEUE_ROWS_LUA,
        2,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        maxQueuedUserEntries === undefined ? '-1' : String(maxQueuedUserEntries),
        String(entries.length),
        ...serialized,
      ),
    );
    if (raw === 0) return { outcome: 'full', entries: [] };
    if (raw === -1) return { outcome: 'conflict', entries: [] };
    if (raw !== 1 && raw !== 2) throw new Error(`unexpected queue ledger enqueue outcome: ${raw}`);
    return { outcome: raw === 1 ? 'enqueued' : 'replayed', entries: entries.map(cloneQueueLedgerEntry) };
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    const ids = await this.redis.lrange(QueueLedgerKeys.order(threadId), 0, -1);
    if (ids.length === 0) return [];
    const raws = await this.redis.hmget(QueueLedgerKeys.entries(threadId), ...ids);
    const entries: QueueLedgerEntry[] = [];
    for (let index = 0; index < ids.length; index += 1) {
      const raw = raws[index];
      if (typeof raw !== 'string') throw new Error(`queue order references missing row: ${ids[index]}`);
      entries.push(hydrateQueueLedgerEntry(raw));
    }
    return entries;
  }

  async get(threadId: string, entryId: string): Promise<QueueLedgerEntry | null> {
    const raw = await this.redis.hget(QueueLedgerKeys.entries(threadId), entryId);
    return raw ? hydrateQueueLedgerEntry(raw) : null;
  }

  async claim(
    threadId: string,
    entryId: string,
    claimId: string,
    claimedAt: number,
    bindTargetCatId?: string,
  ): Promise<QueueLedgerClaimResult> {
    const raw = await this.redis.eval(
      CLAIM_QUEUE_ROW_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      entryId,
      claimId,
      String(claimedAt),
      bindTargetCatId ?? '',
    );
    const result = transitionResult(raw);
    return result.outcome === 'updated'
      ? { outcome: 'claimed', entries: [result.entry], claimId }
      : { outcome: result.outcome };
  }

  async claimPrefix(
    threadId: string,
    entryIds: readonly string[],
    claimId: string,
    claimedAt: number,
  ): Promise<QueueLedgerClaimResult> {
    if (entryIds.length === 0) throw new Error('queue prefix claim requires at least one row');
    const raw = await this.redis.eval(
      CLAIM_QUEUE_PREFIX_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      String(entryIds.length),
      claimId,
      String(claimedAt),
      ...entryIds,
    );
    if (!Array.isArray(raw)) throw new Error('invalid queue prefix claim reply');
    const outcome = Number(raw[0]);
    if (outcome === -1) return { outcome: 'not_found' };
    if (outcome === 0) return { outcome: 'state_changed' };
    if (outcome !== 1 || typeof raw[1] !== 'string') throw new Error('invalid queue prefix claim outcome');
    const encoded: unknown = JSON.parse(raw[1]);
    if (!Array.isArray(encoded) || encoded.some((item) => typeof item !== 'string')) {
      throw new Error('invalid queue prefix claim payload');
    }
    return {
      outcome: 'claimed',
      claimId,
      entries: encoded.map((item) => hydrateQueueLedgerEntry(item)),
    };
  }

  async commit(
    threadId: string,
    entryId: string,
    claimId: string,
    mode: QueueLedgerCommitMode,
    at: number,
  ): Promise<QueueLedgerTransitionResult> {
    return transitionResult(
      await this.redis.eval(
        COMMIT_QUEUE_ROW_LUA,
        2,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        entryId,
        claimId,
        mode,
        String(at),
      ),
    );
  }

  async restore(threadId: string, entryId: string, claimId: string): Promise<QueueLedgerTransitionResult> {
    return transitionResult(
      await this.redis.eval(RESTORE_QUEUE_ROW_LUA, 1, QueueLedgerKeys.entries(threadId), entryId, claimId),
    );
  }
}
