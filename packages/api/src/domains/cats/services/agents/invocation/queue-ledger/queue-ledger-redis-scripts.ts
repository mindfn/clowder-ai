/**
 * ADR-043 queue mutations. Every script performs all validation before its
 * first write because Redis does not roll back writes made before a Lua error.
 */
export const ENQUEUE_QUEUE_ROWS_LUA = `
local rowsKey = KEYS[1]
local orderKey = KEYS[2]
local maxQueuedUsers = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
if not count or count < 1 then return redis.error_reply('QUEUE_ENQUEUE_EMPTY') end

local incoming = {}
local existingCount = 0
local incomingUserSources = {}
for i = 1, count do
  local raw = ARGV[2 + i]
  local row = cjson.decode(raw)
  if not row.id or not row.threadId or row.status ~= 'queued' then
    return redis.error_reply('QUEUE_ENQUEUE_INVALID_ROW')
  end
  local existing = redis.call('HGET', rowsKey, row.id)
  if existing then
    existingCount = existingCount + 1
    if existing ~= raw then return -1 end
  end
  if row.owner and row.owner.kind == 'user' then incomingUserSources[row.payload.sourceId] = true end
  incoming[i] = { id = row.id, raw = raw }
end
if existingCount == count then return 2 end
if existingCount ~= 0 then return -1 end

if maxQueuedUsers and maxQueuedUsers >= 0 then
  local queuedUserSources = {}
  local current = redis.call('HVALS', rowsKey)
  for i = 1, #current do
    local row = cjson.decode(current[i])
    if row.status == 'queued' and row.owner and row.owner.kind == 'user' then
      queuedUserSources[row.payload.sourceId] = true
    end
  end
  for sourceId, _ in pairs(incomingUserSources) do queuedUserSources[sourceId] = true end
  local queuedUserCount = 0
  for _, _ in pairs(queuedUserSources) do queuedUserCount = queuedUserCount + 1 end
  if queuedUserCount > maxQueuedUsers then return 0 end
end

for i = 1, count do
  redis.call('HSET', rowsKey, incoming[i].id, incoming[i].raw)
  redis.call('RPUSH', orderKey, incoming[i].id)
end
return 1
`;

export const CLAIM_QUEUE_ROW_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'queued' then return {0, raw} end
row.status = 'claimed'
row.claimId = ARGV[2]
row.claimedAt = tonumber(ARGV[3])
local bindTargetCatId = ARGV[4]
if bindTargetCatId and bindTargetCatId ~= '' then
  if row.target.kind == 'cat' and row.target.catId ~= bindTargetCatId then return {0, raw} end
  row.target = { kind = 'cat', catId = bindTargetCatId }
end
local next = cjson.encode(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;

export const CLAIM_QUEUE_PREFIX_LUA = `
local count = tonumber(ARGV[1])
if not count or count < 1 then return redis.error_reply('QUEUE_CLAIM_PREFIX_EMPTY') end
local claimId = ARGV[2]
local claimedAt = tonumber(ARGV[3])
local rows = {}
for i = 1, count do
  local id = ARGV[3 + i]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then return {-1, ''} end
  local row = cjson.decode(raw)
  if row.status ~= 'queued' then return {0, raw} end
  rows[i] = { id = id, row = row }
end
local encoded = {}
for i = 1, count do
  rows[i].row.status = 'claimed'
  rows[i].row.claimId = claimId
  rows[i].row.claimedAt = claimedAt
  local next = cjson.encode(rows[i].row)
  redis.call('HSET', KEYS[1], rows[i].id, next)
  encoded[i] = next
end
return {1, cjson.encode(encoded)}
`;

export const COMMIT_QUEUE_ROW_LUA = `
local id = ARGV[1]
local claimId = ARGV[2]
local mode = ARGV[3]
local at = tonumber(ARGV[4])
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return {-1, ''} end
local row = cjson.decode(raw)

if mode == 'processing' then
  if row.status ~= 'claimed' or row.claimId ~= claimId then return {0, raw} end
  row.status = 'processing'
  row.processingStartedAt = at
  row.claimId = nil
  row.claimedAt = nil
  local next = cjson.encode(row)
  redis.call('HSET', KEYS[1], id, next)
  return {1, next}
end
if mode == 'terminal' then
  if row.status ~= 'processing' then return {0, raw} end
elseif mode == 'withdrawn' then
  if row.status ~= 'queued' then return {0, raw} end
else
  return redis.error_reply('QUEUE_COMMIT_INVALID_MODE')
end
redis.call('HDEL', KEYS[1], id)
redis.call('LREM', KEYS[2], 1, id)
return {1, raw}
`;

export const RESTORE_QUEUE_ROW_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'claimed' or row.claimId ~= ARGV[2] then return {0, raw} end
row.status = 'queued'
row.claimId = nil
row.claimedAt = nil
local next = cjson.encode(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;
