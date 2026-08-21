/** Redis durable subscription records and monotonic delivery cursors. */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { CursorStore, SnapshotViewCandidate, SnapshotViewRecord, SubscriptionRecord } from './ports.js';
import { MessagingKeys } from './redis-keys.js';

const CURSOR_ADVANCE_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
local nxt = tonumber(ARGV[2])
if nxt > cur then redis.call('HSET', KEYS[1], ARGV[1], nxt) end
return 0
`;

const SUBSCRIPTION_CREATE_OR_GET_LUA = `
local existing = redis.call('GET', KEYS[2])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
redis.call('HSET', KEYS[4], 'acked', ARGV[4], 'delivered', ARGV[5])
return ARGV[2]
`;

const SNAPSHOT_CREATE_OR_GET_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return '' end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return '' end
local existing = redis.call('GET', KEYS[2])
if existing then
  local decodedExisting = cjson.decode(existing)
  if decodedExisting.status == 'active' then return existing end
end
redis.call('DEL', KEYS[3])
for index = 2, #ARGV do
  redis.call('RPUSH', KEYS[3], ARGV[index])
end
redis.call('SET', KEYS[2], ARGV[1])
return ARGV[1]
`;

const SNAPSHOT_PAGE_READ_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return nil end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return nil end
local raw = redis.call('GET', KEYS[2])
if not raw then return nil end
local state = cjson.decode(raw)
if state.status ~= 'active' or state.snapshotId ~= ARGV[1] then return nil end
local offset = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local itemCount = tonumber(state.itemCount)
if not offset or not limit or not itemCount or offset < 0 or limit < 0 or offset > itemCount then return nil end
if offset == itemCount or limit == 0 then return {} end
local last = math.min(offset + limit - 1, itemCount - 1)
return redis.call('LRANGE', KEYS[3], offset, last)
`;

const SNAPSHOT_ACK_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return -1 end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return -1 end
local raw = redis.call('GET', KEYS[3])
if not raw then return -1 end
local state = cjson.decode(raw)
if state.snapshotId ~= ARGV[1] or tonumber(state.headSequence) ~= tonumber(ARGV[2]) then return -1 end
if state.status == 'completed' then return 0 end
if state.status ~= 'active' or state.traversalComplete ~= true then return -1 end
local acked = tonumber(redis.call('HGET', KEYS[2], 'acked') or '-1')
local delivered = tonumber(redis.call('HGET', KEYS[2], 'delivered') or '-1')
local head = tonumber(ARGV[2])
if head > acked then redis.call('HSET', KEYS[2], 'acked', head) end
if head > delivered then redis.call('HSET', KEYS[2], 'delivered', head) end
redis.call('SET', KEYS[3], ARGV[3])
redis.call('DEL', KEYS[4])
return 1
`;

const SNAPSHOT_PAGE_CONSUME_LUA = `
local sub = redis.call('GET', KEYS[1])
if not sub then return 0 end
local decodedSub = cjson.decode(sub)
if decodedSub.revokedAt ~= nil then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.status ~= 'active' or state.snapshotId ~= ARGV[1] or state.traversalComplete == true then return 0 end
if tonumber(state.nextOffset) ~= tonumber(ARGV[2]) then return 0 end
local currentToken = state.nextPageTokenId or ''
if currentToken ~= ARGV[3] then return 0 end
state.lastPageOffset = tonumber(ARGV[2])
state.nextOffset = tonumber(ARGV[4])
if ARGV[5] == '' then state.nextPageTokenId = nil else state.nextPageTokenId = ARGV[5] end
state.traversalComplete = ARGV[6] == '1'
redis.call('SET', KEYS[2], cjson.encode(state))
return 1
`;

type StoredSnapshotState =
  | ({ readonly status: 'active' } & SnapshotViewRecord)
  | { readonly status: 'completed'; readonly snapshotId: string; readonly headSequence: number };

type PersistedSubscriptionRecord = Omit<SubscriptionRecord, 'snapshotView' | 'lastSnapshotCompletion'>;

function persistedSubscription(record: SubscriptionRecord): PersistedSubscriptionRecord {
  return {
    subscriptionId: record.subscriptionId,
    pluginInstanceId: record.pluginInstanceId,
    handleId: record.handleId,
    threadId: record.threadId,
    ackedSequence: record.ackedSequence,
    lastDeliveredSequence: record.lastDeliveredSequence,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

function snapshotView(state: StoredSnapshotState & { readonly status: 'active' }): SnapshotViewRecord {
  const { status: _status, ...view } = state;
  return view;
}

function snapshotCompletion(
  state: StoredSnapshotState & { readonly status: 'completed' },
): SubscriptionRecord['lastSnapshotCompletion'] {
  const { status: _status, ...completion } = state;
  return completion;
}

export class RedisCursorStore implements CursorStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    await this.redis
      .multi()
      .set(MessagingKeys.subscription(pluginInstanceId, subscriptionId), JSON.stringify(persistedSubscription(record)))
      .set(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId), subscriptionId)
      .sadd(
        MessagingKeys.subscriptionsOfHandle(handleId),
        `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      )
      .hset(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId), {
        acked: String(record.ackedSequence),
        delivered: String(record.lastDeliveredSequence),
      })
      .exec();
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const { pluginInstanceId, subscriptionId, handleId } = record;
    const winner = (await this.redis.eval(
      SUBSCRIPTION_CREATE_OR_GET_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId),
      MessagingKeys.subscriptionsOfHandle(handleId),
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      JSON.stringify(persistedSubscription(record)),
      subscriptionId,
      `${encodeURIComponent(pluginInstanceId)}|${encodeURIComponent(subscriptionId)}`,
      String(record.ackedSequence),
      String(record.lastDeliveredSequence),
    )) as string;
    const loaded = await this.get(pluginInstanceId, winner);
    if (!loaded) throw new Error(`subscription index points to missing record ${winner}`);
    return loaded;
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    const results = await this.redis
      .multi()
      .get(MessagingKeys.subscription(pluginInstanceId, subscriptionId))
      .hgetall(MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId))
      .get(MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId))
      .exec();
    const raw = results?.[0]?.[1];
    if (typeof raw !== 'string') return null;
    const record = JSON.parse(raw) as SubscriptionRecord;
    const cursorResult = results?.[1]?.[1];
    const cursors = cursorResult && typeof cursorResult === 'object' ? (cursorResult as Record<string, string>) : {};
    const snapshotRaw = results?.[2]?.[1];
    const snapshot = typeof snapshotRaw === 'string' ? (JSON.parse(snapshotRaw) as StoredSnapshotState) : undefined;
    return {
      ...record,
      ackedSequence: cursors.acked !== undefined ? Number(cursors.acked) : record.ackedSequence,
      lastDeliveredSequence: cursors.delivered !== undefined ? Number(cursors.delivered) : record.lastDeliveredSequence,
      ...(snapshot?.status === 'active'
        ? { snapshotView: snapshotView(snapshot) }
        : snapshot?.status === 'completed'
          ? { lastSnapshotCompletion: snapshotCompletion(snapshot) }
          : {}),
    };
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = await this.redis.get(MessagingKeys.subscriptionByHandle(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = await this.get(pluginInstanceId, subscriptionId);
    return record && record.revokedAt === undefined ? record : null;
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

  async createOrGetSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshot: SnapshotViewCandidate,
  ): Promise<SnapshotViewRecord | null> {
    const { items, ...candidate } = snapshot;
    const active: StoredSnapshotState = { status: 'active', ...candidate, itemCount: items.length };
    const raw = (await this.redis.eval(
      SNAPSHOT_CREATE_OR_GET_LUA,
      3,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      JSON.stringify(active),
      ...items.map((item) => JSON.stringify(item)),
    )) as string;
    if (!raw) return null;
    const state = JSON.parse(raw) as StoredSnapshotState;
    return state.status === 'active' ? snapshotView(state) : null;
  }

  async readSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<SnapshotViewCandidate['items'] | null> {
    const rows = (await this.redis.eval(
      SNAPSHOT_PAGE_READ_LUA,
      3,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      snapshotId,
      String(offset),
      String(limit),
    )) as string[] | null;
    return rows?.map((row) => JSON.parse(row) as SnapshotViewCandidate['items'][number]) ?? null;
  }

  async ackSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    headSequence: number,
  ): Promise<'applied' | 'replayed' | 'rejected'> {
    const completion: StoredSnapshotState = { status: 'completed', snapshotId, headSequence };
    const result = (await this.redis.eval(
      SNAPSHOT_ACK_LUA,
      4,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionCursor(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshotItems(pluginInstanceId, subscriptionId),
      snapshotId,
      String(headSequence),
      JSON.stringify(completion),
    )) as number;
    return result === 1 ? 'applied' : result === 0 ? 'replayed' : 'rejected';
  }

  async consumeSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expected: { readonly offset: number; readonly tokenId?: string },
    next: { readonly offset: number; readonly tokenId?: string; readonly traversalComplete: boolean },
  ): Promise<boolean> {
    const result = (await this.redis.eval(
      SNAPSHOT_PAGE_CONSUME_LUA,
      2,
      MessagingKeys.subscription(pluginInstanceId, subscriptionId),
      MessagingKeys.subscriptionSnapshot(pluginInstanceId, subscriptionId),
      snapshotId,
      String(expected.offset),
      expected.tokenId ?? '',
      String(next.offset),
      next.tokenId ?? '',
      next.traversalComplete ? '1' : '0',
    )) as number;
    return result === 1;
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    const members = await this.redis.smembers(MessagingKeys.subscriptionsOfHandle(handleId));
    let count = 0;
    for (const member of members) {
      const sep = member.indexOf('|');
      if (sep < 0) continue;
      const instanceId = decodeURIComponent(member.slice(0, sep));
      const subscriptionId = decodeURIComponent(member.slice(sep + 1));
      const record = await this.get(instanceId, subscriptionId);
      if (!record || record.revokedAt !== undefined) continue;
      await this.redis
        .multi()
        .set(
          MessagingKeys.subscription(instanceId, subscriptionId),
          JSON.stringify({ ...persistedSubscription(record), revokedAt }),
        )
        .del(MessagingKeys.subscriptionSnapshot(instanceId, subscriptionId))
        .del(MessagingKeys.subscriptionSnapshotItems(instanceId, subscriptionId))
        .exec();
      count += 1;
    }
    return count;
  }
}
