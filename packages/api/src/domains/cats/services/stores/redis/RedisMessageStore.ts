/**
 * Redis Message Store
 * Redis-backed message storage with same interface as in-memory MessageStore.
 *
 * Redis 数据结构:
 *   cat-cafe:msg:{id}                → Hash (消息详情)
 *   cat-cafe:msg:timeline            → Sorted Set (全局时间线, score=timestamp)
 *   cat-cafe:msg:user:{userId}       → Sorted Set (用户维度)
 *   cat-cafe:msg:mentions:{catId}    → Sorted Set (提及维度)
 *   cat-cafe:msg:thread:{threadId}   → Sorted Set (对话维度)
 *
 * 消息 TTL 可配置 (默认 7 天)。
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type {
  AppendMessageInput,
  MessageDeletionHooks,
  StoredMessage,
  StreamMetadataAugmentInput,
} from '../ports/MessageStore.js';
import {
  applyStreamMetadataAugment,
  assertProvenanceConsistent,
  DEFAULT_THREAD_ID,
  generateSortableId,
  isDelivered,
} from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { isSystemUserMessage } from '../visibility.js';
import {
  hydrateProvenance,
  safeParseConnectorSource,
  safeParseContentBlocks,
  safeParseExtra,
  safeParseMentions,
  safeParseMetadata,
  safeParseRoutingFact,
  safeParseToolEvents,
  serializeExtra,
} from './redis-message-parsers.js';

const log = createModuleLogger('redis-message-store');

const DEFAULT_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

const HARD_DELETE_MESSAGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local authorityOwner = redis.call('HGET', KEYS[1], 'userId') or ''
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then
  return {2, authorityOwner}
end
redis.call('HSET', KEYS[1],
  'content', '',
  'contentBlocks', '',
  'toolEvents', '',
  'metadata', '',
  'extra', '',
  'thinking', '',
  'mentions', '[]',
  'deletedAt', ARGV[1],
  'deletedBy', ARGV[2],
  '_tombstone', '1')
redis.call('HDEL', KEYS[1], 'routingFact', 'provenance')
return {1, authorityOwner}
`;

const MUTATE_LIVE_OR_SOFT_DELETED_MESSAGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then
  return 0
end
if #ARGV > 0 then
  redis.call('HSET', KEYS[1], unpack(ARGV))
end
return 1
`;

const REASSIGN_MESSAGE_OWNER_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, ''}
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then
  return {0, ''}
end
local currentOwner = redis.call('HGET', KEYS[1], 'userId') or ''
if currentOwner ~= ARGV[1] then
  return {2, currentOwner}
end
local effectiveOrderAt = redis.call('HGET', KEYS[1], 'deliveredAt')
  or redis.call('HGET', KEYS[1], 'timestamp')
if not effectiveOrderAt then
  return {0, currentOwner}
end
redis.call('HSET', KEYS[1], 'userId', ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[3], effectiveOrderAt, ARGV[3])
if tonumber(ARGV[4]) > 0 then
  redis.call('EXPIRE', KEYS[3], ARGV[4])
end
return {1, effectiveOrderAt}
`;

const MARK_MESSAGE_DELIVERED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, ''}
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then
  return {0, ''}
end
local currentOwner = redis.call('HGET', KEYS[1], 'userId') or ''
if currentOwner ~= ARGV[3] then
  return {3, currentOwner}
end
if redis.call('HGET', KEYS[1], 'deliveryStatus') ~= 'queued' then
  return {2, currentOwner}
end
redis.call('HSET', KEYS[1], 'deliveredAt', ARGV[2], 'deliveryStatus', 'delivered')
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
return {1, currentOwner}
`;

const RESTORE_SOFT_DELETED_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then
  return 0
end
if not redis.call('HGET', KEYS[1], 'deletedAt') or not redis.call('HGET', KEYS[1], 'deletedBy') then
  return 0
end
redis.call('HDEL', KEYS[1], 'deletedAt', 'deletedBy')
return 1
`;

/**
 * F257 V1 (§4.5.1): async projection worker for embedded RoutingDecisionFacts.
 * Contract: project() never rejects — it records its own failures persistently
 * (no silent swallow; reconcile-before-evaluate repairs any gap).
 */
export interface RoutingFactProjector {
  project(msg: Pick<StoredMessage, 'id' | 'userId' | 'timestamp' | 'routingFact'>): Promise<void>;
}

export class RedisMessageStore {
  private readonly redis: RedisClient;
  /** null means no expiration/pruning (persistent retention). */
  private readonly ttlSeconds: number | null;
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
  /** F257 V1: routing-fact projection worker (owns its error accounting — §4.5.1③) */
  private readonly routingFactProjection?: RoutingFactProjector;
  private readonly deletionHooks: MessageDeletionHooks;

  constructor(
    redis: RedisClient,
    options?: {
      ttlSeconds?: number;
      onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
      routingFactProjection?: RoutingFactProjector;
    } & MessageDeletionHooks,
  ) {
    this.redis = redis;
    this.onAppend = options?.onAppend;
    if (options?.routingFactProjection) {
      this.routingFactProjection = options.routingFactProjection;
    }
    this.deletionHooks = options ?? {};
    const raw = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  /** Resolve ioredis keyPrefix (SCAN doesn't auto-apply it) */
  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  /** Strip keyPrefix from a raw SCAN key for use with normal commands (which auto-prefix) */
  private stripPrefix(rawKey: string): string {
    const p = this.keyPrefix;
    return p && rawKey.startsWith(p) ? rawKey.slice(p.length) : rawKey;
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const matchPattern = `${this.keyPrefix}${pattern}`;
    const matched: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = nextCursor;
      matched.push(...keys.map((key) => this.stripPrefix(key)));
    } while (cursor !== '0');
    return matched;
  }

  private async scanAuthorityIdsByThread(threadId: string): Promise<string[]> {
    const keys = await this.scanKeys(MessageKeys.detail('*'));
    if (keys.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.hget(key, 'threadId');
    const results = await pipeline.exec();
    const ids: string[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const [err, value] = results?.[index] ?? [null, null];
      const key = keys[index];
      if (!err && value === threadId && key) ids.push(key.replace(/^msg:/, ''));
    }
    return ids;
  }

  /**
   * v2.3.8 terminal write barrier for every single-hash mutator. The existence
   * and tombstone checks live in the same Lua command as HSET, so a caller that
   * read an active snapshot before hard/physical deletion cannot recreate data.
   */
  private async mutateLiveOrSoftDeletedMessage(id: string, fields: Record<string, string>): Promise<boolean> {
    const args = Object.entries(fields).flat();
    return (
      Number(await this.redis.eval(MUTATE_LIVE_OR_SOFT_DELETED_MESSAGE_LUA, 1, MessageKeys.detail(id), ...args)) === 1
    );
  }

  async append(msg: AppendMessageInput): Promise<StoredMessage> {
    assertProvenanceConsistent(msg); // sol R3 P1-1: writer bugs fail at the write boundary
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const id = generateSortableId(msg.timestamp);
    const idempotencyIndexKey = msg.idempotencyKey
      ? MessageKeys.idempotency(msg.userId, threadId, msg.idempotencyKey)
      : null;

    if (idempotencyIndexKey) {
      const existingId = await this.redis.get(idempotencyIndexKey);
      if (existingId) {
        const existingMessage = await this.getById(existingId);
        if (existingMessage) {
          return existingMessage;
        }
        await this.redis.del(idempotencyIndexKey);
      }

      const claimed =
        this.ttlSeconds === null
          ? await this.redis.set(idempotencyIndexKey, id, 'NX')
          : await this.redis.set(idempotencyIndexKey, id, 'EX', this.ttlSeconds, 'NX');

      if (claimed !== 'OK') {
        const claimedId = await this.redis.get(idempotencyIndexKey);
        if (claimedId) {
          const existingMessage = await this.getById(claimedId);
          if (existingMessage) {
            return existingMessage;
          }
        }
        throw new Error('message idempotency key contention');
      }
    }

    const { idempotencyKey, ...payload } = msg;
    void idempotencyKey;
    const stored: StoredMessage = { ...payload, id, threadId };
    const score = msg.timestamp;

    const hashKey = MessageKeys.detail(id);
    const pipeline = this.redis.multi();

    // Store message hash (including threadId, contentBlocks, toolEvents, metadata)
    pipeline.hset(hashKey, {
      id,
      threadId,
      userId: msg.userId,
      catId: msg.catId ?? '',
      content: msg.content,
      contentBlocks: msg.contentBlocks ? JSON.stringify(msg.contentBlocks) : '',
      toolEvents: msg.toolEvents ? JSON.stringify(msg.toolEvents) : '',
      metadata: msg.metadata ? JSON.stringify(msg.metadata) : '',
      extra: msg.extra ? serializeExtra(msg.extra) : '',
      mentions: JSON.stringify(msg.mentions),
      timestamp: String(msg.timestamp),
      ...(msg.thinking ? { thinking: msg.thinking } : {}),
      ...(msg.origin ? { origin: msg.origin } : {}),
      ...(msg.visibility ? { visibility: msg.visibility } : {}),
      ...(msg.whisperTo ? { whisperTo: JSON.stringify(msg.whisperTo) } : {}),
      ...(msg.source ? { source: JSON.stringify(msg.source) } : {}),
      ...(msg.mentionsUser ? { mentionsUser: '1' } : {}),
      ...(msg.deliveryStatus ? { deliveryStatus: msg.deliveryStatus } : {}),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      // F257 V1 §4.5.1: authority write — same hset as the message (physical co-fate).
      // sol R1 P1-1: zero-token batches persist too — the fact field doubles as the
      // producer-run marker the coverage cohort audits.
      ...(msg.routingFact ? { routingFact: JSON.stringify(msg.routingFact) } : {}),
      ...(msg.provenance ? { provenance: JSON.stringify(msg.provenance) } : {}),
    });
    if (this.ttlSeconds !== null) {
      pipeline.expire(hashKey, this.ttlSeconds);
    }

    // Add to global timeline
    pipeline.zadd(MessageKeys.TIMELINE, String(score), id);

    // Add to user timeline
    pipeline.zadd(MessageKeys.user(msg.userId), String(score), id);

    // Add to thread timeline
    pipeline.zadd(MessageKeys.thread(threadId), String(score), id);

    // Add to per-cat mention sets
    for (const catId of msg.mentions) {
      pipeline.zadd(MessageKeys.mentions(catId), String(score), id);
    }

    if (this.ttlSeconds !== null) {
      // Prune expired entries from sorted sets (score < now - TTL).
      const cutoff = String(Date.now() - this.ttlSeconds * 1000);
      pipeline.zremrangebyscore(MessageKeys.TIMELINE, '-inf', cutoff);
      pipeline.zremrangebyscore(MessageKeys.user(msg.userId), '-inf', cutoff);
      pipeline.zremrangebyscore(MessageKeys.thread(threadId), '-inf', cutoff);
      for (const catId of msg.mentions) {
        pipeline.zremrangebyscore(MessageKeys.mentions(catId), '-inf', cutoff);
      }

      // Set EXPIRE on index zsets so "silent" keys eventually disappear
      pipeline.expire(MessageKeys.TIMELINE, this.ttlSeconds);
      pipeline.expire(MessageKeys.user(msg.userId), this.ttlSeconds);
      pipeline.expire(MessageKeys.thread(threadId), this.ttlSeconds);
      if (idempotencyIndexKey) {
        pipeline.expire(idempotencyIndexKey, this.ttlSeconds);
      }
      for (const catId of msg.mentions) {
        pipeline.expire(MessageKeys.mentions(catId), this.ttlSeconds);
      }
    }

    try {
      const results = await pipeline.exec();
      // sol R2 P1-3: MULTI has no rollback and resolves per-command errors in
      // the result tuples — swallowing them reports a successful append whose
      // authority never reached the owner timeline (or vice versa).
      if (!results) throw new Error('message append: pipeline exec aborted (null result)');
      for (const [err] of results) {
        if (err) throw err;
      }
    } catch (error) {
      // Partial-execution cleanup: MULTI may have landed a subset of the
      // writes. Undo best-effort so the message is either fully visible or
      // not visible at all — a hash-less timeline entry or an orphan hash
      // both corrupt the collection-integrity audits (§4.5.1 / T-B).
      await this.undoAppendArtifacts(id, msg.userId, threadId, msg.mentions, idempotencyIndexKey);
      throw error;
    }

    // F257 V1 (§4.5.1): async projection derive for the embedded fact. project()
    // owns its error accounting (logged + persisted error marker — never a silent
    // swallow); reconcile-before-evaluate repairs any missed entry.
    if (stored.routingFact && this.routingFactProjection) {
      void this.routingFactProjection.project(stored);
    }

    // F102 KD-34: fire-and-forget append listener for thread index updates
    // P2 fix: wrap in try-catch to handle sync throws (Promise.resolve only catches async rejections)
    if (this.onAppend) {
      try {
        void Promise.resolve(this.onAppend(stored)).catch(() => {});
      } catch {
        /* best-effort */
      }
    }

    return stored;
  }

  /**
   * Best-effort undo of a partially executed append (sol R2 P1-3). Removes the
   * message hash, every index entry this append targeted and the idempotency
   * claim, so a failed append leaves neither an orphan hash nor a hash-less
   * timeline entry. Its own failures are logged loudly — the original append
   * error is what propagates.
   */
  private async undoAppendArtifacts(
    id: string,
    userId: string,
    threadId: string,
    mentions: readonly string[],
    idempotencyIndexKey: string | null,
  ): Promise<void> {
    try {
      const undo = this.redis.pipeline();
      undo.del(MessageKeys.detail(id));
      undo.zrem(MessageKeys.TIMELINE, id);
      undo.zrem(MessageKeys.user(userId), id);
      undo.zrem(MessageKeys.thread(threadId), id);
      for (const catId of mentions) {
        undo.zrem(MessageKeys.mentions(catId), id);
      }
      await undo.exec();
      if (idempotencyIndexKey) {
        const existingId = await this.redis.get(idempotencyIndexKey);
        if (existingId === id) {
          await this.redis.del(idempotencyIndexKey);
        }
      }
    } catch (undoError) {
      log.error({ undoError, messageId: id, threadId }, 'message append undo failed — partial artifacts may remain');
    }
  }

  async getById(id: string): Promise<StoredMessage | null> {
    const data = await this.redis.hgetall(MessageKeys.detail(id));
    if (!data || !data.id) return null;

    const contentBlocks = safeParseContentBlocks(data.contentBlocks);
    const toolEvents = safeParseToolEvents(data.toolEvents);
    const parsedMetadata = safeParseMetadata(data.metadata);
    const parsedExtra = safeParseExtra(data.extra);
    const parsedSource = safeParseConnectorSource(data.source);
    const parsedRoutingFact = safeParseRoutingFact(data.routingFact);
    const parsedProvenance = hydrateProvenance(data.provenance);
    const deletedAt = data.deletedAt ? parseInt(data.deletedAt, 10) : undefined;
    return {
      id: data.id,
      threadId: data.threadId || DEFAULT_THREAD_ID,
      userId: data.userId ?? 'unknown',
      catId: (data.catId || null) as CatId | null,
      content: data.content ?? '',
      ...(contentBlocks ? { contentBlocks } : {}),
      ...(toolEvents ? { toolEvents } : {}),
      ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
      ...(parsedExtra ? { extra: parsedExtra } : {}),
      mentions: safeParseMentions(data.mentions),
      timestamp: parseInt(data.timestamp ?? '0', 10),
      ...(deletedAt ? { deletedAt, deletedBy: data.deletedBy ?? '' } : {}),
      ...(data._tombstone === '1' ? { _tombstone: true as const } : {}),
      ...(data.thinking ? { thinking: data.thinking } : {}),
      ...(data.origin === 'stream' || data.origin === 'callback' || data.origin === 'briefing'
        ? { origin: data.origin as 'stream' | 'callback' | 'briefing' }
        : {}),
      ...(data.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
      ...(data.whisperTo ? { whisperTo: safeParseMentions(data.whisperTo) } : {}),
      ...(data.revealedAt ? { revealedAt: parseInt(data.revealedAt, 10) } : {}),
      ...(data.deliveredAt ? { deliveredAt: parseInt(data.deliveredAt, 10) } : {}),
      ...(data.deliveryStatus ? { deliveryStatus: data.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      ...(data.mentionsUser === '1' ? { mentionsUser: true } : {}),
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
      ...(parsedRoutingFact ? { routingFact: parsedRoutingFact } : {}),
      ...(parsedProvenance ? { provenance: parsedProvenance } : {}),
    };
  }

  /** Scan all stored message hashes (Redis-only repair helper). */
  async scanAll(): Promise<StoredMessage[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const messages: StoredMessage[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hgetall(this.stripPrefix(key));
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          const [err, data] = entry!;
          if (err || !data || typeof data !== 'object') continue;
          const d = data as Record<string, string>;
          if (!d.id) continue;
          const msg = await this.getById(d.id);
          if (msg) messages.push(msg);
        }
      }
    } while (cursor !== '0');
    return messages;
  }

  /**
   * F233: List messages that carry cross-post metadata (extra.crossPost.sourceThreadId).
   * Uses SCAN + pipeline HGET to check the `extra` field efficiently, then hydrates
   * only matching messages. For the FeatTrajectoryCollectorScheduler's CrossPostCollector.
   */
  async listCrossPostMessages(): Promise<StoredMessage[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const results: StoredMessage[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length === 0) continue;
      // Pipeline: fetch only the `extra` field to check for cross-post metadata
      const pipeline = this.redis.pipeline();
      for (const key of keys) pipeline.hget(this.stripPrefix(key), 'extra');
      const extraResults = await pipeline.exec();
      // Collect IDs of messages with cross-post metadata
      const matchedIds: string[] = [];
      for (let i = 0; i < (extraResults?.length ?? 0); i++) {
        const [err, extraRaw] = extraResults![i]!;
        if (err || !extraRaw || typeof extraRaw !== 'string') continue;
        try {
          const parsed = JSON.parse(extraRaw);
          if (parsed?.crossPost?.sourceThreadId) {
            // Extract ID from key: strip prefix, then strip "msg:" prefix
            const stripped = this.stripPrefix(keys[i]);
            const id = stripped.replace(/^msg:/, '');
            matchedIds.push(id);
          }
        } catch {
          // malformed JSON — skip
        }
      }
      // Hydrate matched messages — only include delivered ones
      for (const id of matchedIds) {
        const msg = await this.getById(id);
        if (msg && (!msg.deliveryStatus || msg.deliveryStatus === 'delivered')) {
          results.push(msg);
        }
      }
    } while (cursor !== '0');
    return results;
  }

  /** Reassign a message to a different userId and move user-timeline membership. */
  async reassignUserId(id: string, nextUserId: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    if (msg.userId === nextUserId) {
      if (!(await this.mutateLiveOrSoftDeletedMessage(id, {}))) return null;
      return this.getById(id);
    }

    const oldUserKey = MessageKeys.user(msg.userId);
    const newUserKey = MessageKeys.user(nextUserId);

    const transition = await this.redis.eval(
      REASSIGN_MESSAGE_OWNER_LUA,
      3,
      MessageKeys.detail(id),
      oldUserKey,
      newUserKey,
      msg.userId,
      nextUserId,
      id,
      String(this.ttlSeconds ?? 0),
    );
    if (!Array.isArray(transition) || Number(transition[0]) !== 1) return null;

    // The transition may have observed delivery/metadata changes that landed
    // after our pre-read. Return one real authority snapshot, not a mixture of
    // the old object with the newly committed owner.
    return this.getById(id);
  }

  async getRecent(limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;
    return this.fetchDeliveredDesc(key, n);
  }

  /**
   * Get mentions for a cat, ascending (oldest first after cursor).
   * When afterMessageId is provided, only returns mentions after that ID.
   * Cursor fallback: if afterMessageId not in sorted set (TTL/delete), falls back to full scan (#77 R2 P2).
   */
  async getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    // Cursor fallback: verify afterMessageId exists in the sorted set
    let effectiveAfter = afterMessageId;
    if (effectiveAfter) {
      const rank = await this.redis.zrank(mentionKey, effectiveAfter);
      if (rank === null) {
        log.warn({ cursor: effectiveAfter, catId }, 'cursor not in mention set, falling back to full pending');
        effectiveAfter = undefined;
      }
    }

    // Ascending scan: collect oldest N mentions after cursor
    const CHUNK = 50;
    const ids: string[] = [];
    let startIndex = 0;

    if (effectiveAfter) {
      // Find the rank of afterMessageId and start scanning after it
      const rank = await this.redis.zrank(mentionKey, effectiveAfter);
      if (rank !== null) {
        startIndex = rank + 1; // Start after the cursor
      }
    }

    // Scan forward (ascending) in chunks
    let offset = startIndex;
    while (ids.length < n) {
      const chunk = await this.redis.zrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (ids.length >= n) break;
        // Extra safety: skip IDs <= afterMessageId (handles edge cases)
        if (effectiveAfter && id <= effectiveAfter) continue;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        if (threadId) {
          const score = await this.redis.zscore(MessageKeys.thread(threadId), id);
          if (score === null) continue;
        }
        ids.push(id);
      }
      offset += CHUNK;
    }

    if (ids.length === 0) return [];
    const messages = await this.hydrateMessages(ids); // Already ascending
    return messages.filter(isDelivered);
  }

  /**
   * Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest).
   */
  async getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    const CHUNK = 50;
    const ids: string[] = [];
    let offset = 0;

    // Scan backward (descending) in chunks and filter down to the most recent N matches.
    while (ids.length < n) {
      const chunk = await this.redis.zrevrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (ids.length >= n) break;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        if (threadId) {
          const score = await this.redis.zscore(MessageKeys.thread(threadId), id);
          if (score === null) continue;
        }
        ids.push(id);
      }
      offset += CHUNK;
    }

    if (ids.length === 0) return [];
    const messages = await this.hydrateMessages(ids.reverse());
    return messages.filter(isDelivered);
  }

  async getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;

    if (!beforeId) {
      // F117: Chunked scan (desc) to collect N delivered messages
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (isDelivered(msg)) result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      // Take first N (newest) and reverse to ascending
      return result.slice(0, n).reverse();
    }

    // F117: Scan cursor path with integrated isDelivered filtering
    const result = await this.fetchDeliveredBeforeCursor(key, timestamp, beforeId, n);
    return result.reverse();
  }

  async getByThread(threadId: string, limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    return this.fetchDeliveredDesc(key, n, userId ? (m) => m.userId === userId || isSystemUserMessage(m) : undefined);
  }

  async getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    const CHUNK = Math.max(n, 50);
    const result: StoredMessage[] = [];
    let offset = 0;

    while (result.length < n) {
      const ids = await this.redis.zrevrange(key, offset, offset + CHUNK - 1);
      if (ids.length === 0) break;
      const messages = await this.hydrateMessages(ids);
      for (const msg of messages) {
        if (msg.deletedAt) continue;
        if (msg.deliveryStatus === 'canceled') continue;
        if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
        result.push(msg);
        if (result.length >= n) break;
      }
      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }

    return result.slice(0, n).reverse();
  }

  /**
   * Get messages in a thread after a cursor ID (exclusive), oldest first.
   * If afterId is undefined, returns from thread start.
   * If limit is undefined, returns all matches.
   */
  async getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ): Promise<StoredMessage[]> {
    const key = MessageKeys.thread(threadId);

    let ids: string[];
    if (!afterId) {
      if (limit && limit > 0) {
        ids = await this.redis.zrange(key, 0, limit - 1);
      } else {
        ids = await this.redis.zrange(key, 0, -1);
      }
    } else {
      const afterScore = await this.redis.zscore(key, afterId);
      if (afterScore === null) {
        // Cursor message may have expired; fall back to lexicographic ID filtering.
        ids = await this.redis.zrange(key, 0, -1);
        ids = ids.filter((id) => id > afterId);
      } else {
        // Split into two ranges to avoid filtering by ID across different
        // scores — deliveredAt can shift a message's score forward while
        // its ID still embeds the original send timestamp.
        // 1) Same score as cursor: use ID as tiebreaker
        const sameScore = await this.redis.zrangebyscore(key, afterScore, afterScore);
        const sameFiltered = sameScore.filter((id) => id !== afterId && id > afterId);
        // 2) Strictly higher scores: include all (no ID filter needed)
        const higherScore = await this.redis.zrangebyscore(key, `(${afterScore}`, '+inf');
        ids = [...sameFiltered, ...higherScore];
      }
      if (limit && limit > 0 && ids.length > limit) {
        ids = ids.slice(0, limit);
      }
    }

    if (ids.length === 0) return [];

    // ADR-008 D3: cursor path must include deleted messages (tombstones)
    const messages = await this.hydrateMessages(ids, { includeDeleted: true });
    const delivered = messages.filter(isDelivered);
    if (!userId) return delivered;
    return delivered.filter((m) => m.userId === userId || isSystemUserMessage(m));
  }

  async getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    const userFilter = userId ? (m: StoredMessage) => m.userId === userId || isSystemUserMessage(m) : undefined;

    if (!beforeId) {
      // F117: Chunked desc scan — collect N delivered, scan until full or exhausted
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (!isDelivered(msg)) continue;
          if (userFilter && !userFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      return result.slice(0, n).reverse();
    }

    // F117: Scan cursor path with integrated isDelivered + user filtering
    const result = await this.fetchDeliveredBeforeCursor(key, timestamp, beforeId, n, userFilter);
    return result.reverse();
  }

  /**
   * F117: Scan a sorted set in reverse (newest first), hydrate + filter by isDelivered,
   * collecting up to `n` delivered messages. Returns messages in ascending order (oldest first).
   * Scans until N delivered collected or sorted set exhausted.
   */
  private async fetchDeliveredDesc(
    key: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<StoredMessage[]> {
    const CHUNK = Math.max(n, 50);
    const result: StoredMessage[] = []; // Collects in desc order (newest first)
    let offset = 0;

    while (result.length < n) {
      const ids = await this.redis.zrevrange(key, offset, offset + CHUNK - 1);
      if (ids.length === 0) break; // Sorted set exhausted

      // Hydrate in desc order (don't reverse — preserve newest-first)
      const messages = await this.hydrateMessages(ids);
      for (const msg of messages) {
        if (!isDelivered(msg)) continue;
        if (extraFilter && !extraFilter(msg)) continue;
        result.push(msg);
        if (result.length >= n) break;
      }

      // If Redis returned fewer than CHUNK, the set is exhausted
      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }

    // Take first N (newest) and reverse to ascending order
    return result.slice(0, n).reverse();
  }

  /**
   * Fetch IDs before a composite cursor (timestamp + beforeId) using chunked scanning.
   * Loops until we have `limit` results or exhaust the sorted set.
   */
  private async fetchBeforeWithCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    limit: number,
  ): Promise<string[]> {
    const CHUNK = 50;
    const filtered: string[] = [];
    let offset = 0;

    while (filtered.length < limit) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      for (const id of chunk) {
        if (filtered.length >= limit) break;
        const score = await this.redis.zscore(key, id);
        if (score !== null && parseInt(score, 10) === timestamp && id >= beforeId) {
          continue;
        }
        filtered.push(id);
      }

      offset += CHUNK;
    }

    return filtered;
  }

  /**
   * F117: Scan before a cursor (desc), hydrate + filter by isDelivered + optional extra,
   * collecting exactly N delivered messages or until sorted set exhausted.
   * Returns messages in desc order (newest first). Caller must reverse for asc.
   */
  private async fetchDeliveredBeforeCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<StoredMessage[]> {
    const CHUNK = 50;
    const result: StoredMessage[] = [];
    let offset = 0;

    while (result.length < n) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      // Filter cursor boundary (same logic as fetchBeforeWithCursor)
      const validIds: string[] = [];
      for (const id of chunk) {
        const score = await this.redis.zscore(key, id);
        if (score !== null && Number.parseInt(score, 10) === timestamp && id >= beforeId) {
          continue;
        }
        validIds.push(id);
      }

      if (validIds.length > 0) {
        // Hydrate in desc order (don't reverse)
        const messages = await this.hydrateMessages(validIds);
        for (const msg of messages) {
          if (!isDelivered(msg)) continue;
          if (extraFilter && !extraFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
      }

      if (chunk.length < CHUNK) break;
      offset += CHUNK;
    }

    return result;
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  async deleteByThread(threadId: string): Promise<number> {
    const key = MessageKeys.thread(threadId);
    // The privacy fence is the deletion linearization point. It must run even
    // when the thread index is empty or contains orphan members with no hash.
    this.deletionHooks.onBeforeDeleteByThread?.(threadId);

    const [threadMembers, authorityIds] = await Promise.all([
      this.redis.zrange(key, 0, -1),
      this.scanAuthorityIdsByThread(threadId),
    ]);
    const ids = [...new Set([...threadMembers, ...authorityIds])];
    const idSet = new Set(ids);
    const idempotencyKeys = await this.scanKeys('msg:idem:*');

    const idempotencyRead = this.redis.pipeline();
    for (const idempotencyKey of idempotencyKeys) idempotencyRead.get(idempotencyKey);
    const idempotencyResults = await idempotencyRead.exec();
    const matchingIdempotencyKeys: string[] = [];
    for (let index = 0; index < idempotencyKeys.length; index += 1) {
      const [err, value] = idempotencyResults?.[index] ?? [null, null];
      const idempotencyKey = idempotencyKeys[index];
      if (!err && typeof value === 'string' && idSet.has(value) && idempotencyKey) {
        matchingIdempotencyKeys.push(idempotencyKey);
      }
    }

    // Delete authority first, but retain the thread index until every derived
    // sibling is clean. Once detail hashes are absent, guarded message/projector
    // writers cannot create a new sibling between the final SCAN and cleanup.
    const transition = this.redis.multi();
    for (const id of ids) {
      // Authority scan may discover an id missing from the thread index. Add a
      // temporary discovery anchor in the same transaction that deletes the
      // hash; NX preserves healthy timeline scores. A cleanup failure can then
      // retry from the thread id even though authority is already absent.
      transition.zadd(key, 'NX', '0', id);
      transition.del(MessageKeys.detail(id));
      transition.zrem(MessageKeys.TIMELINE, id);
    }
    for (const idempotencyKey of matchingIdempotencyKeys) transition.del(idempotencyKey);

    const transitionResults = await transition.exec();
    if (!transitionResults) throw new Error('message thread delete: authority transition aborted');
    for (const [err] of transitionResults) {
      if (err) throw err;
    }

    // A missing/malformed detail hash cannot identify its historic owner or
    // mention indexes. Scan after the authority transition so the key set is
    // stable: any stale writer now fails its atomic terminal check. Keeping the
    // thread members until this phase succeeds makes cleanup retryable.
    const indexKeys = await Promise.all([
      this.scanKeys('msg:user:*'),
      this.scanKeys('msg:mentions:*'),
      this.scanKeys('routing-fact:idx:*'),
      this.scanKeys('routing-fact:proj-errors:*'),
    ]).then((groups) => groups.flat());
    const cleanup = this.redis.multi();
    for (const id of ids) {
      for (const indexKey of indexKeys) cleanup.zrem(indexKey, id);
    }
    const cleanupResults = await cleanup.exec();
    if (!cleanupResults) throw new Error('message thread delete: sibling cleanup aborted');
    for (const [err] of cleanupResults) {
      if (err) throw err;
    }
    await this.redis.del(key);
    return ids.length;
  }

  /**
   * ADR-008 D3: Soft delete — set deletedAt/deletedBy on message hash.
   */
  async softDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const now = Date.now();
    const mutated = await this.mutateLiveOrSoftDeletedMessage(id, {
      deletedAt: String(now),
      deletedBy,
    });
    if (!mutated) return null;
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   */
  async hardDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    if (!msg._tombstone) this.deletionHooks.onBeforeHardDelete?.(msg);
    const now = Date.now();
    const transition = await this.redis.eval(
      HARD_DELETE_MESSAGE_LUA,
      1,
      MessageKeys.detail(id),
      String(now),
      deletedBy,
    );
    if (!Array.isArray(transition)) return null;
    const transitionStatus = Number(transition[0]);
    if (transitionStatus !== 1 && transitionStatus !== 2) return null;
    const routingIndexKeys = await Promise.all([
      this.scanKeys('routing-fact:idx:*'),
      this.scanKeys('routing-fact:proj-errors:*'),
    ]).then((groups) => groups.flat());
    const pipeline = this.redis.multi();
    for (const indexKey of routingIndexKeys) pipeline.zrem(indexKey, id);
    for (const catId of msg.mentions) {
      pipeline.zrem(MessageKeys.mentions(catId), id);
    }
    const results = await pipeline.exec();
    if (!results) throw new Error('message hard delete: pipeline exec aborted');
    for (const [err] of results) {
      if (err) throw err;
    }
    if (transitionStatus === 2) return null;
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    delete msg.routingFact;
    delete msg.provenance;
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message — remove deletedAt/deletedBy.
   * Rejects tombstones (hard-deleted messages are irreversible).
   */
  async restore(id: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    const restored = Number(await this.redis.eval(RESTORE_SOFT_DELETED_LUA, 1, MessageKeys.detail(id)));
    if (restored !== 1) return null;
    delete msg.deletedAt;
    delete msg.deletedBy;
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  async revealWhispers(threadId: string, userId: string): Promise<number> {
    const key = MessageKeys.thread(threadId);
    const ids = await this.redis.zrange(key, 0, -1);
    if (ids.length === 0) return 0;

    const now = String(Date.now());
    let count = 0;
    for (const id of ids) {
      const fields = await this.redis.hmget(MessageKeys.detail(id), 'visibility', 'revealedAt', 'userId');
      if (fields[0] !== 'whisper') continue;
      if (fields[1]) continue; // already revealed
      if (fields[2] !== userId) continue; // only reveal caller's whispers
      if (await this.mutateLiveOrSoftDeletedMessage(id, { revealedAt: now })) count++;
    }
    return count;
  }

  /** F096: Update message extra data (merge semantics — preserves existing fields). */
  async updateExtra(id: string, extra: NonNullable<StoredMessage['extra']>): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const merged = { ...msg.extra, ...extra };
    if (!(await this.mutateLiveOrSoftDeletedMessage(id, { extra: serializeExtra(merged) }))) return null;
    msg.extra = merged;
    return msg;
  }

  async augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const augmented = applyStreamMetadataAugment(msg, patch);
    const fields: Record<string, string> = {};
    if (patch.thinking && augmented.thinking) fields.thinking = augmented.thinking;
    if (patch.metadata && augmented.metadata) fields.metadata = JSON.stringify(augmented.metadata);
    if (patch.toolEvents?.length && augmented.toolEvents) fields.toolEvents = JSON.stringify(augmented.toolEvents);
    if (patch.replyTo && augmented.replyTo) fields.replyTo = augmented.replyTo;
    if (patch.mentionsUser && augmented.mentionsUser) fields.mentionsUser = '1';
    if (patch.extra && augmented.extra) fields.extra = serializeExtra(augmented.extra);
    if (!(await this.mutateLiveOrSoftDeletedMessage(id, fields))) return null;
    return augmented;
  }

  /** F098-D: Mark a queued message as delivered (set deliveredAt timestamp). */
  async markDelivered(id: string, deliveredAt: number): Promise<StoredMessage | null> {
    let msg = await this.getById(id);
    while (msg) {
      const transition = await this.redis.eval(
        MARK_MESSAGE_DELIVERED_LUA,
        4,
        MessageKeys.detail(id),
        MessageKeys.thread(msg.threadId),
        MessageKeys.TIMELINE,
        MessageKeys.user(msg.userId),
        id,
        String(deliveredAt),
        msg.userId,
      );
      if (!Array.isArray(transition)) return null;
      const transitionStatus = Number(transition[0]);
      if (transitionStatus === 0) return null;
      if (transitionStatus === 2) return this.getById(id); // active non-queued message: existing no-op contract
      if (transitionStatus === 3) {
        // Owner changed after our snapshot. Re-read the authority and retry so
        // the delivery score can only land in the commit-time current owner.
        msg = await this.getById(id);
        continue;
      }
      if (transitionStatus !== 1) return null;
      msg.deliveredAt = deliveredAt;
      msg.deliveryStatus = 'delivered';
      return msg;
    }
    return null;
  }

  /** F117: Mark a queued message as canceled (withdraw/clear). */
  async markCanceled(id: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    if (!(await this.mutateLiveOrSoftDeletedMessage(id, { deliveryStatus: 'canceled' }))) return null;
    msg.deliveryStatus = 'canceled';
    return msg;
  }

  /**
   * Atomic content-dedup claim via SET NX PX. Returns true on first claim within the window,
   * false if an identical claim is still live (concurrent or recent byte-identical post). This
   * is the race-safe gate for the callback exact-duplicate scan.
   */
  async claimContentDedupKey(key: string, ttlMs: number): Promise<boolean> {
    const claimed = await this.redis.set(
      MessageKeys.contentDedup(key),
      '1',
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );
    return claimed === 'OK';
  }

  /**
   * #697: Scan for message IDs matching a given deliveryStatus.
   * Uses SCAN + pipeline HGET pattern (same as InvocationRecordStore.scanByStatus).
   * Called by StartupReconciler to find orphaned queued messages after restart.
   */
  async scanByDeliveryStatus(status: string): Promise<string[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const ids: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hget(this.stripPrefix(key), 'deliveryStatus');
        }
        const results = await pipeline.exec();
        for (let i = 0; i < keys.length; i++) {
          const [err, val] = results?.[i] ?? [null, null];
          if (!err && val === status) {
            ids.push(this.stripPrefix(keys[i]!).replace(/^msg:/, ''));
          }
        }
      }
    } while (cursor !== '0');
    return ids;
  }

  /** Hydrate message IDs into full StoredMessage objects */
  private async hydrateMessages(ids: string[], options?: { includeDeleted?: boolean }): Promise<StoredMessage[]> {
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(MessageKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const messages: StoredMessage[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) continue;

      const deletedAt = d.deletedAt ? parseInt(d.deletedAt, 10) : undefined;

      // ADR-008 D3: skip soft-deleted messages unless includeDeleted
      if (deletedAt && !options?.includeDeleted) continue;

      const contentBlocks = safeParseContentBlocks(d.contentBlocks);
      const toolEvents = safeParseToolEvents(d.toolEvents);
      const parsedMetadata = safeParseMetadata(d.metadata);
      const parsedExtra = safeParseExtra(d.extra);
      const parsedSource = safeParseConnectorSource(d.source);
      const parsedRoutingFact = safeParseRoutingFact(d.routingFact);
      const parsedProvenanceD = hydrateProvenance(d.provenance);
      messages.push({
        id: d.id,
        threadId: d.threadId || DEFAULT_THREAD_ID,
        userId: d.userId ?? 'unknown',
        catId: (d.catId || null) as CatId | null,
        content: d.content ?? '',
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(toolEvents ? { toolEvents } : {}),
        ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
        ...(parsedExtra ? { extra: parsedExtra } : {}),
        mentions: safeParseMentions(d.mentions),
        timestamp: parseInt(d.timestamp ?? '0', 10),
        ...(deletedAt ? { deletedAt, deletedBy: d.deletedBy ?? '' } : {}),
        ...(d._tombstone === '1' ? { _tombstone: true as const } : {}),
        ...(d.thinking ? { thinking: d.thinking } : {}),
        ...(d.origin === 'stream' || d.origin === 'callback' || d.origin === 'briefing'
          ? { origin: d.origin as 'stream' | 'callback' | 'briefing' }
          : {}),
        ...(d.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
        ...(d.whisperTo ? { whisperTo: safeParseMentions(d.whisperTo) } : {}),
        ...(d.revealedAt ? { revealedAt: parseInt(d.revealedAt, 10) } : {}),
        ...(d.deliveredAt ? { deliveredAt: parseInt(d.deliveredAt, 10) } : {}),
        ...(d.deliveryStatus ? { deliveryStatus: d.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
        ...(parsedSource ? { source: parsedSource } : {}),
        ...(d.mentionsUser === '1' ? { mentionsUser: true } : {}),
        ...(d.replyTo ? { replyTo: d.replyTo } : {}),
        ...(parsedRoutingFact ? { routingFact: parsedRoutingFact } : {}),
        ...(parsedProvenanceD ? { provenance: parsedProvenanceD } : {}),
      });
    }
    return messages;
  }
}
