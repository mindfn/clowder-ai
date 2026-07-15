/**
 * Plugin Messaging — Redis store implementations (K-1 / F258)
 *
 * Atomicity strategy:
 * - Ledger claim/settle/release: single Lua scripts (state machine §4a).
 * - Event append: one Lua script does dedupe-check → INCR seq → ZADD → trim
 *   (INV-3). Events are stored WITHOUT sequence; the ZSET score is the
 *   authoritative sequence, stamped on the read path — no JSON mutation in Lua.
 * - Cursor advances: Lua max-advance on a hash field (monotonic).
 * - Append lock: SET NX PX + del-if-token-matches release.
 * - Handle revoke / subscription revoke: JS read-modify-write — control-plane
 *   frequency, idempotent, first-revocation timestamp sticks.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { MessageOutputEvent, MessageOutputEventInput } from '../contract/types.js';
import type {
  AppendLock,
  CursorStore,
  EventLogAppendResult,
  EventLogStore,
  HandleRecord,
  HandleStore,
  LedgerClaimResult,
  LedgerStore,
  SubscriptionRecord,
} from './ports.js';
import { MessagingKeys } from './redis-keys.js';

// ── Ledger ──

const LEDGER_CLAIM_LUA = `
local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return false
`;

const LEDGER_SETTLE_LUA = `
local v = redis.call('GET', KEYS[1])
if v and string.find(v, '"status":"settled"', 1, true) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`;

const LEDGER_RELEASE_LUA = `
local v = redis.call('GET', KEYS[1])
if v and string.find(v, '"status":"inflight"', 1, true) then redis.call('DEL', KEYS[1]) end
return 0
`;

export class RedisLedgerStore implements LedgerStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async claim(key: string, claimTtlMs: number): Promise<LedgerClaimResult> {
    const existing = (await this.redis.eval(
      LEDGER_CLAIM_LUA,
      1,
      MessagingKeys.ledger(key),
      JSON.stringify({ status: 'inflight' }),
      String(claimTtlMs),
    )) as string | null;
    if (existing === null || existing === undefined) return { status: 'new' };
    const parsed = JSON.parse(existing) as { status: string; receipt?: unknown };
    if (parsed.status === 'settled') return { status: 'settled', receipt: parsed.receipt };
    return { status: 'inflight' };
  }

  async settle(key: string, receipt: unknown, retentionMs: number): Promise<void> {
    await this.redis.eval(
      LEDGER_SETTLE_LUA,
      1,
      MessagingKeys.ledger(key),
      JSON.stringify({ status: 'settled', receipt }),
      String(retentionMs),
    );
  }

  async release(key: string): Promise<void> {
    await this.redis.eval(LEDGER_RELEASE_LUA, 1, MessagingKeys.ledger(key));
  }
}

// ── Handles ──

export class RedisHandleStore implements HandleStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: HandleRecord): Promise<void> {
    await this.redis.set(MessagingKeys.handle(record.handleId), JSON.stringify(record));
  }

  async get(handleId: string): Promise<HandleRecord | null> {
    const raw = await this.redis.get(MessagingKeys.handle(handleId));
    return raw ? (JSON.parse(raw) as HandleRecord) : null;
  }

  async revoke(handleId: string, revokedAt: number): Promise<boolean> {
    const record = await this.get(handleId);
    if (!record) return false;
    if (record.revokedAt === undefined) {
      await this.put({ ...record, revokedAt });
    }
    return true;
  }
}

// ── Event log ──

const EVENT_APPEND_LUA = `
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then return {existing, 1} end
local seq = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[1], seq, ARGV[1] .. '|' .. ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], seq)
local retention = tonumber(ARGV[3])
local count = redis.call('ZCARD', KEYS[1])
if count > retention then
  local removed = redis.call('ZRANGE', KEYS[1], 0, count - retention - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - retention - 1)
  for _, member in ipairs(removed) do
    local sep = string.find(member, '|', 1, true)
    if sep then redis.call('HDEL', KEYS[2], string.sub(member, 1, sep - 1)) end
  end
end
return {tostring(seq), 0}
`;

export class RedisEventLogStore implements EventLogStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async append(
    threadId: string,
    eventKey: string,
    event: MessageOutputEventInput,
    retentionCount: number,
  ): Promise<EventLogAppendResult> {
    // Encoded eventKey is the member prefix AND dedupe hash field — '|' inside
    // caller keys can never split the member incorrectly.
    const encodedKey = encodeURIComponent(eventKey);
    const result = (await this.redis.eval(
      EVENT_APPEND_LUA,
      3,
      MessagingKeys.events(threadId),
      MessagingKeys.eventDedupe(threadId),
      MessagingKeys.eventSeq(threadId),
      encodedKey,
      JSON.stringify(event),
      String(retentionCount),
    )) as [string, number];
    return { sequence: Number(result[0]), deduped: result[1] === 1 };
  }

  private static parseMember(member: string, score: string): MessageOutputEvent {
    const sep = member.indexOf('|');
    const json = sep >= 0 ? member.slice(sep + 1) : member;
    const event = JSON.parse(json) as MessageOutputEventInput;
    return { ...event, sequence: Number(score) } as MessageOutputEvent;
  }

  async readAfter(threadId: string, afterSequence: number, limit: number): Promise<MessageOutputEvent[]> {
    const raw = (await this.redis.zrangebyscore(
      MessagingKeys.events(threadId),
      `(${afterSequence}`,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    )) as string[];
    const events: MessageOutputEvent[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const member = raw[i];
      const score = raw[i + 1];
      if (member !== undefined && score !== undefined) {
        events.push(RedisEventLogStore.parseMember(member, score));
      }
    }
    return events;
  }

  async minSequence(threadId: string): Promise<number | null> {
    const raw = (await this.redis.zrange(MessagingKeys.events(threadId), 0, 0, 'WITHSCORES')) as string[];
    const score = raw[1];
    return score !== undefined ? Number(score) : null;
  }

  async headSequence(threadId: string): Promise<number> {
    const raw = await this.redis.get(MessagingKeys.eventSeq(threadId));
    return raw ? Number(raw) : 0;
  }
}

// ── Subscriptions + cursors ──

const CURSOR_ADVANCE_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
local nxt = tonumber(ARGV[2])
if nxt > cur then redis.call('HSET', KEYS[1], ARGV[1], nxt) end
return 0
`;

export class RedisCursorStore implements CursorStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    await this.redis.set(MessagingKeys.subscription(pluginInstanceId, subscriptionId), JSON.stringify(record));
    await this.redis.set(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId), subscriptionId);
    await this.redis.sadd(
      MessagingKeys.subscriptionsOfHandle(handleId),
      `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
    );
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const raw = await this.redis.get(MessagingKeys.subscription(pluginInstanceId, subscriptionId));
    if (!raw) return null;
    const record = JSON.parse(raw) as SubscriptionRecord;
    const cursors = await this.redis.hgetall(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId));
    return {
      ...record,
      ackedSequence: cursors.acked !== undefined ? Number(cursors.acked) : record.ackedSequence,
      lastDeliveredSequence: cursors.delivered !== undefined ? Number(cursors.delivered) : record.lastDeliveredSequence,
    };
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = await this.redis.get(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = await this.get(pluginInstanceId, subscriptionId);
    if (!record || record.revokedAt !== undefined) return null;
    return record;
  }

  private async advance(
    pluginInstanceId: string,
    subscriptionId: string,
    field: 'acked' | 'delivered',
    sequence: number,
  ): Promise<void> {
    await this.redis.eval(
      CURSOR_ADVANCE_LUA,
      1,
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      field,
      String(sequence),
    );
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'acked', sequence);
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    await this.advance(pluginInstanceId, subscriptionId, 'delivered', sequence);
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    const members = await this.redis.smembers(MessagingKeys.subscriptionsOfHandle(handleId));
    let count = 0;
    for (const member of members) {
      const sep = member.indexOf('|');
      if (sep < 0) continue;
      const instanceId = decodeURIComponent(member.slice(0, sep));
      const subscriptionId = decodeURIComponent(member.slice(sep + 1));
      const raw = await this.redis.get(MessagingKeys.subscription(instanceId, subscriptionId));
      if (!raw) continue;
      const record = JSON.parse(raw) as SubscriptionRecord;
      if (record.revokedAt !== undefined) continue;
      await this.redis.set(
        MessagingKeys.subscription(instanceId, subscriptionId),
        JSON.stringify({ ...record, revokedAt }),
      );
      count += 1;
    }
    return count;
  }
}

// ── Append lock ──

const LOCK_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 0
`;

export class RedisAppendLock implements AppendLock {
  private readonly redis: RedisClient;
  private readonly tokens = new Map<string, string>();
  private tokenSeq = 0;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async acquire(messageId: string, ttlMs: number): Promise<boolean> {
    this.tokenSeq += 1;
    const token = `${process.pid}-${this.tokenSeq}-${Math.random().toString(36).slice(2)}`;
    const result = await this.redis.set(MessagingKeys.appendLock(messageId), token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return false;
    this.tokens.set(messageId, token);
    return true;
  }

  async release(messageId: string): Promise<void> {
    const token = this.tokens.get(messageId);
    if (token === undefined) return;
    this.tokens.delete(messageId);
    await this.redis.eval(LOCK_RELEASE_LUA, 1, MessagingKeys.appendLock(messageId), token);
  }
}
