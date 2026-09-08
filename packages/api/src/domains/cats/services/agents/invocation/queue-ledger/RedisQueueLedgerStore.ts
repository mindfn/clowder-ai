import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertQueueLedgerEntry,
  cloneQueueLedgerEntry,
  type QueueLedgerClaimResult,
  type QueueLedgerCommitMode,
  type QueueLedgerEnqueueResult,
  type QueueLedgerEntry,
  type QueueLedgerStore,
  type QueueLedgerTargetExpansionResult,
  type QueueLedgerTargetReconcileResult,
  type QueueLedgerTransitionResult,
  queueEntryId,
  queueLedgerAdmissionsMatch,
} from './QueueLedger.js';
import { QueueLedgerKeys } from './queue-ledger-keys.js';
import {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  ENQUEUE_QUEUE_ROWS_LUA,
  EXPAND_QUEUE_TARGET_ROWS_LUA,
  MIGRATE_QUEUE_LEDGER_V2_LUA,
  RECONCILE_QUEUE_TARGETS_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-scripts.js';

type PersistedQueueRow = Record<string, unknown> & {
  id?: unknown;
  version?: unknown;
  status?: unknown;
  target?: unknown;
  targets?: unknown;
  payload?: unknown;
  delivery?: unknown;
  enqueuedAt?: unknown;
};

export interface QueueLedgerV2MigrationPlan {
  entries: Array<[id: string, raw: string]>;
  order: string[];
  messageIndex: Record<string, string[]>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Collapse the retired v1 source×target rows into one v2 source entry. Only
 * work that was still queued/short-claimed survives: processing/terminal rows
 * were already admitted and must never be resurrected after a restart.
 */
export function migrateQueueLedgerRowsToV2(
  rawById: Readonly<Record<string, string>>,
  persistedOrder: readonly string[],
): QueueLedgerV2MigrationPlan {
  const orderRank = new Map(persistedOrder.map((id, index) => [id, index]));
  const candidates = Object.entries(rawById)
    .map(([storedId, raw]) => {
      const parsed = JSON.parse(raw) as unknown;
      const row = record(parsed) as PersistedQueueRow | null;
      if (!row) throw new Error(`corrupt queue ledger row: ${storedId}`);
      return { storedId, row };
    })
    .sort((left, right) => {
      const leftRank = orderRank.get(left.storedId) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = orderRank.get(right.storedId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftAt = typeof left.row.enqueuedAt === 'number' ? left.row.enqueuedAt : Number.MAX_SAFE_INTEGER;
      const rightAt = typeof right.row.enqueuedAt === 'number' ? right.row.enqueuedAt : Number.MAX_SAFE_INTEGER;
      return leftAt - rightAt || left.storedId.localeCompare(right.storedId);
    });

  const grouped = new Map<
    string,
    { row: Record<string, unknown>; targets: string[]; seenTargets: Set<string>; intents: Record<string, unknown> }
  >();
  for (const { storedId, row } of candidates) {
    if (row.version !== 1 && row.version !== 2) {
      throw new Error(`unsupported queue ledger entry version: ${String(row.version)}`);
    }
    if (row.status !== 'queued' && row.status !== 'claimed') continue;
    const payload = record(row.payload);
    const sourceRecordId = payload?.sourceRecordId ?? payload?.sourceId;
    if (typeof sourceRecordId !== 'string' || !sourceRecordId) {
      throw new Error(`queue ledger payload identity is incomplete: ${storedId}`);
    }
    const rawTargets: string[] = [];
    if (Array.isArray(row.targets)) {
      for (const targetId of row.targets) {
        if (typeof targetId !== 'string' || !targetId) throw new Error(`queue ledger targets are invalid: ${storedId}`);
        rawTargets.push(targetId);
      }
    } else {
      const target = record(row.target);
      if (target?.kind === 'cat' && typeof target.catId === 'string' && target.catId) rawTargets.push(target.catId);
      else if (target?.kind !== 'unassigned') throw new Error(`queue ledger target is invalid: ${storedId}`);
    }

    let group = grouped.get(sourceRecordId);
    if (!group) {
      const nextPayload: Record<string, unknown> = { ...payload, sourceRecordId };
      delete nextPayload.sourceId;
      const nextRow: Record<string, unknown> = {
        ...row,
        version: 2,
        id: queueEntryId(sourceRecordId),
        payload: nextPayload,
      };
      delete nextRow.target;
      delete nextRow.claimId;
      delete nextRow.claimedAt;
      delete nextRow.claimedTargetIds;
      delete nextRow.claimedFromTargetless;
      delete nextRow.processingStartedAt;
      delete nextRow.terminalAt;
      delete nextRow.retiringGroupId;
      nextRow.status = 'queued';
      group = { row: nextRow, targets: [], seenTargets: new Set(), intents: {} };
      grouped.set(sourceRecordId, group);
    }
    for (const targetId of rawTargets) {
      if (!group.seenTargets.has(targetId)) {
        group.seenTargets.add(targetId);
        group.targets.push(targetId);
      }
    }
    const delivery = record(row.delivery);
    const byTarget = record(delivery?.authorIntentByTarget);
    if (byTarget) {
      for (const targetId of rawTargets) {
        if (byTarget[targetId] !== undefined) group.intents[targetId] = byTarget[targetId];
      }
    } else if (delivery?.authorIntent !== undefined && rawTargets.length === 1) {
      group.intents[rawTargets[0] as string] = delivery.authorIntent;
    }
  }

  const entries: Array<[string, string]> = [];
  const order: string[] = [];
  const messageIndex: Record<string, string[]> = {};
  for (const group of grouped.values()) {
    const pendingIntents = Object.fromEntries(
      group.targets.flatMap((targetId) =>
        group.intents[targetId] === undefined ? [] : [[targetId, group.intents[targetId]]],
      ),
    );
    group.row.targets = group.targets;
    group.row.delivery = Object.keys(pendingIntents).length > 0 ? { authorIntentByTarget: pendingIntents } : {};
    const entry = group.row as unknown as QueueLedgerEntry;
    assertQueueLedgerEntry(entry);
    const raw = JSON.stringify(entry);
    entries.push([entry.id, raw]);
    order.push(entry.id);
    if (entry.payload.messageId) messageIndex[entry.payload.messageId] = [entry.id];
  }
  return { entries, order, messageIndex };
}

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
  private readonly migrations = new Map<string, Promise<void>>();

  constructor(private readonly redis: RedisClient) {}

  usesRedisClient(redis: RedisClient): boolean {
    return this.redis === redis;
  }

  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  private async ensureThreadMigrated(threadId: string): Promise<void> {
    const existing = this.migrations.get(threadId);
    if (existing) return existing;
    const migration = this.migrateThread(threadId).catch((error) => {
      this.migrations.delete(threadId);
      throw error;
    });
    this.migrations.set(threadId, migration);
    return migration;
  }

  private async migrateThread(threadId: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await this.redis.get(QueueLedgerKeys.schema(threadId))) === '2') return;
      const [rawById, order] = await Promise.all([
        this.redis.hgetall(QueueLedgerKeys.entries(threadId)),
        this.redis.lrange(QueueLedgerKeys.order(threadId), 0, -1),
      ]);
      const plan = migrateQueueLedgerRowsToV2(rawById, order);
      const expectedEntries = Object.entries(rawById).sort(([left], [right]) => left.localeCompare(right));
      const result = Number(
        await this.redis.eval(
          MIGRATE_QUEUE_LEDGER_V2_LUA,
          4,
          QueueLedgerKeys.entries(threadId),
          QueueLedgerKeys.order(threadId),
          QueueLedgerKeys.messageIndex(threadId),
          QueueLedgerKeys.schema(threadId),
          JSON.stringify(expectedEntries),
          JSON.stringify(order),
          JSON.stringify(plan.entries),
          JSON.stringify(plan.order),
          JSON.stringify(plan.messageIndex),
        ),
      );
      if (result === 1 || result === 2) return;
      if (result !== 0) throw new Error(`unexpected Queue v2 migration outcome: ${result}`);
    }
    throw new Error(`Queue v2 migration did not converge for thread ${threadId}`);
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
    await this.ensureThreadMigrated(threadId);
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

  async expandTargets(
    threadId: string,
    entryId: string,
    bindTargetCatId: string,
    expectedQueuedEntryIds: readonly string[],
    siblingEntries: readonly QueueLedgerEntry[],
  ): Promise<QueueLedgerTargetExpansionResult> {
    await this.ensureThreadMigrated(threadId);
    if (!bindTargetCatId) throw new Error('queue target expansion requires a target');
    for (const entry of siblingEntries) assertQueueLedgerEntry(entry);
    const result = (await this.redis.eval(
      EXPAND_QUEUE_TARGET_ROWS_LUA,
      3,
      QueueLedgerKeys.entries(threadId),
      QueueLedgerKeys.order(threadId),
      QueueLedgerKeys.messageIndex(threadId),
      entryId,
      bindTargetCatId,
      String(expectedQueuedEntryIds.length),
      String(siblingEntries.length),
      ...expectedQueuedEntryIds,
      ...siblingEntries.map((entry) => JSON.stringify(entry)),
    )) as [number | string, string];
    const raw = Number(result[0]);
    if (raw === -2) return { outcome: 'not_found', entries: [] };
    if (raw === 0) return { outcome: 'state_changed', entries: [] };
    if (raw === -1) return { outcome: 'conflict', entries: [] };
    if (raw !== 1 && raw !== 2) throw new Error(`unexpected queue target expansion outcome: ${raw}`);
    const serialized = JSON.parse(result[1]) as unknown;
    if (!Array.isArray(serialized) || serialized.some((value) => typeof value !== 'string')) {
      throw new Error('Queue target expansion returned invalid committed rows');
    }
    const entries = serialized.map((value) => hydrateQueueLedgerEntry(value));
    const anchor = entries[0];
    if (!anchor || !anchor.targets.includes(bindTargetCatId)) {
      return { outcome: 'conflict', entries: [] };
    }
    if (
      !entries.slice(1 + expectedQueuedEntryIds.length).every((entry, index) => {
        const input = siblingEntries[index];
        return input !== undefined && queueLedgerAdmissionsMatch(entry, input);
      })
    ) {
      return { outcome: 'conflict', entries: [] };
    }
    return { outcome: raw === 1 ? 'expanded' : 'replayed', entries };
  }

  async reconcileTargets(
    threadId: string,
    entryId: string,
    addTargetIds: readonly string[],
    removeTargetIds: readonly string[],
    authorIntentByTarget: Readonly<NonNullable<QueueLedgerEntry['delivery']['authorIntentByTarget']>> = {},
  ): Promise<QueueLedgerTargetReconcileResult> {
    await this.ensureThreadMigrated(threadId);
    const result = (await this.redis.eval(
      RECONCILE_QUEUE_TARGETS_LUA,
      3,
      QueueLedgerKeys.entries(threadId),
      QueueLedgerKeys.order(threadId),
      QueueLedgerKeys.messageIndex(threadId),
      entryId,
      JSON.stringify(addTargetIds),
      JSON.stringify(removeTargetIds),
      JSON.stringify(authorIntentByTarget ?? {}),
    )) as [number | string, string];
    const outcome = Number(result[0]);
    if (outcome === -1) return { outcome: 'not_found' };
    if (outcome === 0) return { outcome: 'state_changed' };
    if (outcome !== 1 && outcome !== 2) throw new Error(`unexpected Queue target reconcile outcome: ${outcome}`);
    const entry = result[1] ? hydrateQueueLedgerEntry(result[1]) : null;
    return { outcome: outcome === 1 ? 'updated' : 'replayed', entry };
  }

  async list(threadId: string): Promise<QueueLedgerEntry[]> {
    await this.ensureThreadMigrated(threadId);
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
    await this.ensureThreadMigrated(threadId);
    const raws = await this.redis.hvals(QueueLedgerKeys.entries(threadId));
    return raws
      .map(hydrateQueueLedgerEntry)
      .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id));
  }

  async getByMessageIds(threadId: string, messageIds: readonly string[]): Promise<Map<string, QueueLedgerEntry[]>> {
    await this.ensureThreadMigrated(threadId);
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
    await this.ensureThreadMigrated(threadId);
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
    await this.ensureThreadMigrated(threadId);
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
    await this.ensureThreadMigrated(threadId);
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
    await this.ensureThreadMigrated(threadId);
    if (replacement) assertQueueLedgerEntry(replacement);
    return transitionResult(
      await this.redis.eval(
        COMMIT_QUEUE_ROW_LUA,
        3,
        QueueLedgerKeys.entries(threadId),
        QueueLedgerKeys.order(threadId),
        QueueLedgerKeys.messageIndex(threadId),
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
    await this.ensureThreadMigrated(threadId);
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
