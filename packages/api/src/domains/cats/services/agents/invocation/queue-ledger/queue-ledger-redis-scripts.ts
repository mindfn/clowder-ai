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
  end
  if row.from and row.from.kind == 'user' then incomingUserSources[row.payload.sourceId] = true end
  incoming[i] = { id = row.id, raw = raw }
end
if existingCount == count then return 2 end
if existingCount ~= 0 then return -1 end

if maxQueuedUsers and maxQueuedUsers >= 0 then
  local queuedUserSources = {}
  local current = redis.call('HVALS', rowsKey)
  for i = 1, #current do
    local row = cjson.decode(current[i])
    if row.status == 'queued' and row.from and row.from.kind == 'user' then
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
local steerRequestedAt = tonumber(ARGV[5])
if steerRequestedAt then row.delivery.steerRequestedAt = steerRequestedAt end
local next = cjson.encode(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;

export const CLAIM_QUEUE_PREFIX_LUA = `
local count = tonumber(ARGV[1])
if not count or count < 1 then return redis.error_reply('QUEUE_CLAIM_PREFIX_EMPTY') end
local claimId = ARGV[2]
local claimedAt = tonumber(ARGV[3])
local bindTargetCatId = ARGV[4]
local steerRequestedAt = tonumber(ARGV[5])
local rows = {}
for i = 1, count do
  local id = ARGV[5 + i]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then return {-1, ''} end
  local row = cjson.decode(raw)
  if row.status ~= 'queued' then return {0, raw} end
  if bindTargetCatId and bindTargetCatId ~= '' and row.target.kind == 'cat' and row.target.catId ~= bindTargetCatId then
    return {0, raw}
  end
  rows[i] = { id = id, row = row }
end
local encoded = {}
for i = 1, count do
  rows[i].row.status = 'claimed'
  rows[i].row.claimId = claimId
  rows[i].row.claimedAt = claimedAt
  if bindTargetCatId and bindTargetCatId ~= '' then
    rows[i].row.target = { kind = 'cat', catId = bindTargetCatId }
  end
  if steerRequestedAt then rows[i].row.delivery.steerRequestedAt = steerRequestedAt end
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
local replacementRaw = ARGV[5]
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return {-1, ''} end
local row = cjson.decode(raw)

if mode == 'queued' or mode == 'processing' then
  if row.status ~= 'claimed' or row.claimId ~= claimId then return {0, raw} end
  local nextRow = row
  if replacementRaw and replacementRaw ~= '' then
    nextRow = cjson.decode(replacementRaw)
    if nextRow.id ~= id or nextRow.threadId ~= row.threadId then
      return redis.error_reply('QUEUE_COMMIT_IDENTITY_MISMATCH')
    end
  end
  nextRow.status = mode
  if mode == 'processing' then
    nextRow.processingStartedAt = at
  else
    nextRow.processingStartedAt = nil
  end
  nextRow.claimId = nil
  nextRow.claimedAt = nil
  local next = cjson.encode(nextRow)
  redis.call('HSET', KEYS[1], id, next)
  return {1, next}
end
if mode == 'terminal' then
  if row.status ~= 'processing' then return {0, raw} end
elseif mode == 'withdrawn' then
  if row.status ~= 'claimed' or row.claimId ~= claimId then return {0, raw} end
else
  return redis.error_reply('QUEUE_COMMIT_INVALID_MODE')
end
if replacementRaw and replacementRaw ~= '' then
  local replacement = cjson.decode(replacementRaw)
  if replacement.id ~= id or replacement.threadId ~= row.threadId then
    return redis.error_reply('QUEUE_COMMIT_IDENTITY_MISMATCH')
  end
  row = replacement
end
row.status = 'terminal'
row.terminalAt = at
if mode == 'withdrawn' then
  row.delivery.terminalOutcome = 'withdrawn'
  row.delivery.failedAt = at
  row.delivery.failureReason = 'source_withdrawn'
end
row.claimId = nil
row.claimedAt = nil
local terminal = cjson.encode(row)
redis.call('HSET', KEYS[1], id, terminal)
redis.call('LREM', KEYS[2], 1, id)
return {1, terminal}
`;

export const RESTORE_QUEUE_ROW_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'claimed' or row.claimId ~= ARGV[2] then return {0, raw} end
row.status = 'queued'
row.claimId = nil
row.claimedAt = nil
row.delivery.steerRequestedAt = nil
if ARGV[3] == '1' then
  row.target = {kind = 'unassigned'}
end
local next = cjson.encode(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;
