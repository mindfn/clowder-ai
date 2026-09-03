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
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  ENQUEUE_QUEUE_ROWS_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-scripts.js';

export function hydrateQueueLedgerEntry(raw: string): QueueLedgerEntry {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('corrupt queue ledger row');
  const entry = parsed as QueueLedgerEntry;
  assertQueueLedgerEntry(entry);
  return entry;
}

function hydrateQueueMessageIndex(raw: string, messageId: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entryId) => typeof entryId !== 'string' || entryId.length === 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`corrupt queue message index: ${messageId}`);
  }
  return parsed;
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

  usesRedisClient(redis: RedisClient): boolean {
    return this.redis === redis;
  }

  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

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
        3,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        QueueLedgerKeys.messageIndex(threadId),
        maxQueuedUserEntries === undefined ? '-1' : String(maxQueuedUserEntries),
        String(entries.length),
        ...serialized,
      ),
    );
    if (raw === 0) return { outcome: 'full', entries: [] };
    if (raw === -1) return { outcome: 'conflict', entries: [] };
    if (raw !== 1 && raw !== 2) throw new Error(`unexpected queue ledger enqueue outcome: ${raw}`);
    if (raw === 1) return { outcome: 'enqueued', entries: entries.map(cloneQueueLedgerEntry) };
    const existingRaws = await this.redis.hmget(QueueLedgerKeys.entries(threadId), ...entries.map((entry) => entry.id));
    if (existingRaws.some((value) => typeof value !== 'string')) {
      throw new Error('Queue replay identity vanished after atomic preflight');
    }
    const existing = existingRaws.map((value) => hydrateQueueLedgerEntry(value as string));
    if (
      !existing.every((entry, index) => {
        const input = entries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
      })
    ) {
      return { outcome: 'conflict', entries: [] };
    }
    return { outcome: 'replayed', entries: existing };
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

  async listAll(threadId: string): Promise<QueueLedgerEntry[]> {
    const raws = await this.redis.hvals(QueueLedgerKeys.entries(threadId));
    return raws
      .map(hydrateQueueLedgerEntry)
      .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id));
  }

  async getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>> {
    const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))];
    const grouped = new Map<string, QueueLedgerEntry[]>();
    if (uniqueMessageIds.length === 0) return grouped;
    const rawIndexes = await this.redis.hmget(QueueLedgerKeys.messageIndex(threadId), ...uniqueMessageIds);
    const entryIdsByMessage = new Map<string, string[]>();
    const allEntryIds = new Set<string>();
    for (let index = 0; index < uniqueMessageIds.length; index += 1) {
      const raw = rawIndexes[index];
      if (typeof raw !== 'string') continue;
      const messageId = uniqueMessageIds[index];
      if (!messageId) throw new Error('queue message index result length mismatch');
      const entryIds = hydrateQueueMessageIndex(raw, messageId);
      entryIdsByMessage.set(messageId, entryIds);
      for (const entryId of entryIds) allEntryIds.add(entryId);
    }
    if (allEntryIds.size === 0) return grouped;
    const orderedEntryIds = [...allEntryIds];
    const raws = await this.redis.hmget(QueueLedgerKeys.entries(threadId), ...orderedEntryIds);
    const entriesById = new Map<string, QueueLedgerEntry>();
    for (let index = 0; index < orderedEntryIds.length; index += 1) {
      const entryId = orderedEntryIds[index];
      if (!entryId) throw new Error('queue entry result length mismatch');
      const raw = raws[index];
      if (typeof raw !== 'string') throw new Error(`queue message index references missing row: ${entryId}`);
      entriesById.set(entryId, hydrateQueueLedgerEntry(raw));
    }
    for (const [messageId, entryIds] of entryIdsByMessage) {
      const entries = entryIds.map((entryId) => {
        const entry = entriesById.get(entryId);
        if (!entry) throw new Error(`queue message index references missing row: ${entryId}`);
        return entry;
      });
      if (entries.some((entry) => entry.payload.messageId !== messageId)) {
        throw new Error(`queue message index identity mismatch: ${messageId}`);
      }
      grouped.set(messageId, entries);
    }
    return grouped;
  }

  async listThreadIds(): Promise<string[]> {
    const threadIds = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${this.keyPrefix}queue:{*}:order`,
        'COUNT',
        200,
      );
      cursor = nextCursor;
      for (const key of keys) {
        const localKey = this.keyPrefix && key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) : key;
        const match = /^queue:\{(.+)\}:order$/.exec(localKey);
        if (match?.[1]) threadIds.add(decodeURIComponent(match[1]));
      }
    } while (cursor !== '0');
    return [...threadIds].sort();
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
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    const raw = await this.redis.eval(
      CLAIM_QUEUE_ROW_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      entryId,
      claimId,
      String(claimedAt),
      bindTargetCatId ?? '',
      steerRequestedAt === undefined ? '' : String(steerRequestedAt),
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
    bindTargetCatId?: string,
    steerRequestedAt?: number,
  ): Promise<QueueLedgerClaimResult> {
    if (entryIds.length === 0) throw new Error('queue prefix claim requires at least one row');
    const raw = await this.redis.eval(
      CLAIM_QUEUE_PREFIX_LUA,
      1,
      QueueLedgerKeys.entries(threadId),
      String(entryIds.length),
      claimId,
      String(claimedAt),
      bindTargetCatId ?? '',
      steerRequestedAt === undefined ? '' : String(steerRequestedAt),
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
    replacement?: QueueLedgerEntry,
  ): Promise<QueueLedgerTransitionResult> {
    if (replacement) assertQueueLedgerEntry(replacement);
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
        replacement ? JSON.stringify(replacement) : '',
      ),
    );
  }

  async restore(
    threadId: string,
    entryId: string,
    claimId: string,
    restoreUnassignedTarget = false,
  ): Promise<QueueLedgerTransitionResult> {
    return transitionResult(
      await this.redis.eval(
        RESTORE_QUEUE_ROW_LUA,
        1,
        QueueLedgerKeys.entries(threadId),
        entryId,
        claimId,
        restoreUnassignedTarget ? '1' : '0',
      ),
    );
  }
}
