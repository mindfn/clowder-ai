/** Message-owned projection: refs only, TTL=0. The request body remains in the canonical message hash. */
export const USER_MENTION_INDEX_LUA = `
local function mentionKeys(hash)
  local row = redis.call('HMGET', hash, 'id', 'userId', 'threadId')
  if not row[1] or not row[2] or not row[3] then return nil end
  local prefix = string.sub(hash, 1, #hash - #row[1] - 4)
  return {prefix .. 'msg:user-requests:latest:' .. row[2], prefix .. 'msg:user-requests:pending:' .. row[2],
    prefix .. 'msg:user-requests:closed:' .. row[2], prefix .. 'msg:user-request-signals:' .. row[2] .. ':' .. row[3]}
end
local function mentionAux(keys, kind)
  return (string.gsub(keys[1], 'msg:user%-requests:latest:', 'msg:user-requests:' .. kind .. ':', 1))
end
local function mentionRevision(keys, thread)
  local raw = redis.call('HGET', mentionAux(keys, 'revision'), thread)
  if not raw then return 0 end
  if not string.match(raw, '^%d+$') or (#raw > 1 and string.sub(raw,1,1) == '0') then error('USER_MENTION_REVISION_INVALID') end
  local number = tonumber(raw)
  if not number or number < 0 or number >= 9007199254740990 or number ~= math.floor(number) then error('USER_MENTION_REVISION_INVALID') end
  return number
end
local function bumpMentionRevision(keys, thread)
  return redis.call('HINCRBY', mentionAux(keys, 'revision'), thread, 1)
end
local function checkMentionKeys(keys)
  if not keys then return end
  for _, kind in ipairs({'revision', 'restored'}) do
    local actual = redis.call('TYPE', mentionAux(keys, kind)).ok
    if actual ~= 'none' and actual ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
  end
  if keys[4] then
    local signalPrefix = (string.gsub(keys[1], 'msg:user%-requests:latest:', 'msg:user-request-signals:', 1)) .. ':'
    mentionRevision(keys, string.sub(keys[4], #signalPrefix + 1))
  end
  local kinds = {'hash', 'zset', 'hash', 'zset'}
  for i, key in ipairs(keys) do
    local actual = redis.call('TYPE', key).ok
    local kind = kinds[i]
    if actual ~= 'none' and actual ~= kind then error('USER_MENTION_INDEX_INVALID') end
  end
end
local function mentionEvent(hash)
  local r = redis.call('HMGET', hash, 'id', 'userId', 'threadId', 'catId', 'mentionsUser', 'visibility',
    'source', 'origin', 'extra', 'deliveryStatus', 'deletedAt', 'recall')
  if not r[1] or r[6] == 'whisper' or (r[7] and r[7] ~= '') or r[8] == 'briefing' or r[11] or r[12] then return nil end
  if r[2] == 'system' or r[2] == 'scheduler' or r[4] == 'system' then return nil end
  local extra = {}
  if r[9] and r[9] ~= '' then
    local ok, parsed = pcall(cjson.decode, r[9])
    if not ok or type(parsed) ~= 'table' then return nil end
    extra = parsed
  end
  if extra.systemKind or extra.systemInfo then return nil end
  local cat = r[4] and r[4] ~= ''
  if r[10] and r[10] ~= '' and r[10] ~= 'delivered' then
    if r[10] ~= 'queued' or not cat then return nil end
  end
  if not cat and extra.crossPost then return nil end
  if cat and r[5] ~= '1' then return nil end
  return cat and 'request' or 'reply', r[1], r[3], r[2]
end
local function refreshMention(hash)
  local event, id, thread = mentionEvent(hash)
  if not event then return end
  local keys = mentionKeys(hash)
  checkMentionKeys(keys)
  local closedThrough = redis.call('HGET', keys[3], thread) or ''
  if id <= closedThrough then return end
  if event == 'request' then
    if not redis.call('ZSCORE', keys[4], id) then bumpMentionRevision(keys, thread) end
    redis.call('ZADD', keys[4], 0, id)
  else
    bumpMentionRevision(keys, thread)
    redis.call('HDEL', mentionAux(keys, 'restored'), thread)
    redis.call('HSET', keys[3], thread, id)
    redis.call('ZREMRANGEBYLEX', keys[4], '-', '[' .. id)
  end
  local previous = redis.call('HGET', keys[1], thread)
  if previous and previous >= id then return end
  redis.call('HSET', keys[1], thread, id)
  if event == 'request' then redis.call('ZADD', keys[2], 0, thread)
  else redis.call('ZREM', keys[2], thread) end
end
`;

/** Shares the canonical write's linearization point, including frontier append and metadata replacement. */
export function withUserMentionIndex(script: string, hashKey = 1, newKeysExpression?: string): string {
  return `${USER_MENTION_INDEX_LUA}
checkMentionKeys(mentionKeys(KEYS[${hashKey}])${newKeysExpression ? ` or ${newKeysExpression}` : ''})
local mentionResult = (function()
${script}
end)()
refreshMention(KEYS[${hashKey}])
return mentionResult
`;
}

/** Migrate persisted flags in bounded Lua batches so long-lived owners never hit a history-size cliff. */
export const READ_USER_MENTIONS_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[2], KEYS[3], KEYS[5]})
local version = redis.call('GET', KEYS[4])
if version ~= '1' then
  -- If deletion removed the saved cursor, restart safely: refresh is idempotent
  -- and cannot reopen resolved rows or overwrite newer append-owned signals.
  local offset = 0
  if version then
    if string.sub(version, 1, 7) ~= 'cursor:' then return redis.error_reply('USER_MENTION_INDEX_VERSION_INVALID') end
    local rank = redis.call('ZRANK', KEYS[1], string.sub(version, 8))
    if rank then offset = rank + 1 end
  end
  local batch = redis.call('ZRANGE', KEYS[1], offset, offset + 999)
  for _, id in ipairs(batch) do refreshMention(ARGV[1] .. 'msg:' .. id) end
  if #batch == 1000 then
    redis.call('SET', KEYS[4], 'cursor:' .. batch[#batch])
    return {'more'}
  end
  redis.call('SET', KEYS[4], '1')
end
local ids = {'complete'}
for _, thread in ipairs(redis.call('ZRANGE', KEYS[3], 0, -1)) do
  local id = redis.call('HGET', KEYS[2], thread)
  local closedThrough = redis.call('HGET', KEYS[5], thread) or ''
  local restoredId = redis.call('HGET', mentionAux({KEYS[2]}, 'restored'), thread)
  local event, _, sourceThread, owner
  if id then event, _, sourceThread, owner = mentionEvent(ARGV[1] .. 'msg:' .. id) end
  if event ~= 'request' or owner ~= ARGV[2] or sourceThread ~= thread or (id <= closedThrough and id ~= restoredId) then
    local signals = ARGV[1] .. 'msg:user-request-signals:' .. ARGV[2] .. ':' .. thread
    checkMentionKeys({KEYS[2], KEYS[3], KEYS[5], signals})
    local candidates = redis.call('ZREVRANGEBYLEX', signals, '+', '(' .. closedThrough, 'LIMIT', 0, 1000)
    id = nil
    for _, candidate in ipairs(candidates) do
      local kind, _, candidateThread, candidateOwner = mentionEvent(ARGV[1] .. 'msg:' .. candidate)
      if kind == 'request' and candidateThread == thread and candidateOwner == ARGV[2] then
        id = candidate
        redis.call('HSET', KEYS[2], thread, id)
        break
      end
      redis.call('ZREM', signals, candidate)
    end
    if not id and #candidates == 1000 then return {'more'} end
    if not id and restoredId then
      local kind, _, restoredThread, restoredOwner = mentionEvent(ARGV[1] .. 'msg:' .. restoredId)
      if kind == 'request' and restoredThread == thread and restoredOwner == ARGV[2] then
        id = restoredId
        redis.call('HSET', KEYS[2], thread, id)
      else redis.call('HDEL', mentionAux({KEYS[2]}, 'restored'), thread) end
    end
  end
  if id then table.insert(ids, id)
  else
    redis.call('ZREM', KEYS[3], thread)
    if closedThrough ~= '' then redis.call('HSET', KEYS[2], thread, closedThrough)
    else redis.call('HDEL', KEYS[2], thread) end
  end
end
return ids
`;

export const RESOLVE_USER_MENTION_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[1],KEYS[2],KEYS[3],KEYS[4]})
local historyType=redis.call('TYPE',KEYS[5]).ok
if historyType ~= 'none' and historyType ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
local kind, id, thread, owner = mentionEvent(KEYS[6])
if kind ~= 'request' or id ~= ARGV[2] or thread ~= ARGV[1] or owner ~= ARGV[4] then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
local revision = mentionRevision(KEYS, ARGV[1])
local restored = redis.call('HGET', mentionAux(KEYS, 'restored'), ARGV[1])
if (ARGV[3] ~= '' and tonumber(ARGV[3]) ~= revision) or (ARGV[3] == '' and restored) then return 0 end
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 1 then
  redis.call('HSET',KEYS[5],ARGV[2],ARGV[1])
  local closed = redis.call('HGET', KEYS[3], ARGV[1]) or ''
  if ARGV[2] > closed then closed = ARGV[2] end
  redis.call('HSET', KEYS[3], ARGV[1], closed)
  redis.call('HDEL', mentionAux(KEYS, 'restored'), ARGV[1])
  bumpMentionRevision(KEYS, ARGV[1])
  redis.call('ZREMRANGEBYLEX', KEYS[4], '-', '[' .. (redis.call('HGET', KEYS[3], ARGV[1]) or ARGV[2]))
end
return removed
`;
