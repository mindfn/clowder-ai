/**
 * Lua for the two scripts that admit rows into the durable ledger: the v2 schema migration that
 * makes a thread's row set readable, and the atomic enqueue that decides replay / conflict / full.
 *
 * They live apart from the read and target-mutation scripts because they are the only ones that
 * create rows, and because the enqueue script owns the `private_input` admission receipt — the
 * durable winner a retired private row leaves behind.
 */
export const MIGRATE_QUEUE_LEDGER_V2_LUA = `
local currentSchema = redis.call('GET', KEYS[4])
if currentSchema == '2' then return 2 end

local expectedEntries = cjson.decode(ARGV[1])
local expectedOrder = cjson.decode(ARGV[2])
local nextEntries = cjson.decode(ARGV[3])
local nextOrder = cjson.decode(ARGV[4])
local nextMessageIndex = cjson.decode(ARGV[5])
if type(expectedEntries) ~= 'table' or type(expectedOrder) ~= 'table' or
   type(nextEntries) ~= 'table' or type(nextOrder) ~= 'table' or type(nextMessageIndex) ~= 'table' then
  return redis.error_reply('QUEUE_V2_MIGRATION_INVALID')
end

local currentPairs = redis.call('HGETALL', KEYS[1])
if #currentPairs ~= #expectedEntries * 2 then return 0 end
local currentById = {}
for i = 1, #currentPairs, 2 do currentById[currentPairs[i]] = currentPairs[i + 1] end
for i = 1, #expectedEntries do
  local pair = expectedEntries[i]
  if type(pair) ~= 'table' or type(pair[1]) ~= 'string' or type(pair[2]) ~= 'string' or
     currentById[pair[1]] ~= pair[2] then return 0 end
end

local currentOrder = redis.call('LRANGE', KEYS[2], 0, -1)
if #currentOrder ~= #expectedOrder then return 0 end
for i = 1, #expectedOrder do if currentOrder[i] ~= expectedOrder[i] then return 0 end end

-- Redis does not roll back writes when a Lua script raises. Validate every
-- replacement pair before deleting the v1 hashes/lists.
for i = 1, #nextEntries do
  local pair = nextEntries[i]
  if type(pair) ~= 'table' or type(pair[1]) ~= 'string' or type(pair[2]) ~= 'string' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_ENTRY')
  end
end
for i = 1, #nextOrder do
  if type(nextOrder[i]) ~= 'string' or nextOrder[i] == '' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_ORDER')
  end
end
for messageId, entryIds in pairs(nextMessageIndex) do
  if type(messageId) ~= 'string' or messageId == '' or type(entryIds) ~= 'table' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_MESSAGE_INDEX')
  end
  for i = 1, #entryIds do
    if type(entryIds[i]) ~= 'string' or entryIds[i] == '' then
      return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_MESSAGE_INDEX')
    end
  end
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
for i = 1, #nextEntries do
  local pair = nextEntries[i]
  redis.call('HSET', KEYS[1], pair[1], pair[2])
end
for i = 1, #nextOrder do redis.call('RPUSH', KEYS[2], nextOrder[i]) end
for messageId, entryIds in pairs(nextMessageIndex) do
  redis.call('HSET', KEYS[3], messageId, cjson.encode(entryIds))
end
redis.call('SET', KEYS[4], '2')
return 1
`;

export const ENQUEUE_QUEUE_ROWS_LUA = `
local rowsKey = KEYS[1]
local orderKey = KEYS[2]
local privateAdmissionsKey = KEYS[4]
local maxQueuedUsers = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
if not count or count < 1 then return redis.error_reply('QUEUE_ENQUEUE_EMPTY') end

local incoming = {}
local settledCount = 0
local incomingUserSources = {}
for i = 1, count do
  local raw = ARGV[2 + i]
  -- Fingerprints travel beside the rows so Lua and TypeScript can never disagree about envelope
  -- identity through a serialization difference; both compare the exact string TypeScript computed.
  local fingerprint = ARGV[2 + count + i]
  local row = cjson.decode(raw)
  if not row.id or not row.threadId or row.status ~= 'queued' then
    return redis.error_reply('QUEUE_ENQUEUE_INVALID_ROW')
  end
  if not fingerprint or fingerprint == '' then
    return redis.error_reply('QUEUE_ENQUEUE_MISSING_FINGERPRINT')
  end
  local existing = redis.call('HGET', rowsKey, row.id)
  -- A private input owns no History message, so its admission receipt is the durable winner.
  -- The row itself is retired on purpose once its last target reaches processing; without the
  -- receipt a stable producer key would be admitted — and executed — a second time.
  local settled = existing ~= false and existing ~= nil
  if not settled and row.kind == 'private_input' then
    local receipt = redis.call('HGET', privateAdmissionsKey, row.id)
    if receipt ~= false and receipt ~= nil then
      settled = true
      -- Same key, different envelope: the retired identity must refuse it exactly as a live row
      -- would, instead of reporting a changed payload as successfully admitted.
      if receipt ~= fingerprint then return -1 end
    end
  end
  if settled then
    settledCount = settledCount + 1
  end
  if row.from and row.from.kind == 'user' then incomingUserSources[row.payload.sourceRecordId] = true end
  incoming[i] = { id = row.id, raw = raw, row = row, fingerprint = fingerprint }
end
if settledCount == count then return 2 end
if settledCount ~= 0 then return -1 end

local messageIndexUpdates = {}
for i = 1, count do
  local row = incoming[i].row
  local messageId = row.payload and row.payload.messageId
  if messageId and messageId ~= '' then
    local update = messageIndexUpdates[messageId]
    if not update then
      update = { ids = {}, seen = {} }
      local existingIndexRaw = redis.call('HGET', KEYS[3], messageId)
      if existingIndexRaw then
        local decodedOk, decoded = pcall(cjson.decode, existingIndexRaw)
        if not decodedOk or type(decoded) ~= 'table' then
          return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID')
        end
        for j = 1, #decoded do
          if type(decoded[j]) ~= 'string' or decoded[j] == '' or update.seen[decoded[j]] then
            return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID')
          end
          update.seen[decoded[j]] = true
          update.ids[#update.ids + 1] = decoded[j]
        end
      end
      messageIndexUpdates[messageId] = update
    end
    if not update.seen[row.id] then
      update.seen[row.id] = true
      update.ids[#update.ids + 1] = row.id
    end
  end
end

if maxQueuedUsers and maxQueuedUsers >= 0 then
  local queuedUserSources = {}
  local activeIds = redis.call('LRANGE', orderKey, 0, -1)
  for i = 1, #activeIds do
    local currentRaw = redis.call('HGET', rowsKey, activeIds[i])
    if not currentRaw then return redis.error_reply('QUEUE_ORDER_ROW_MISSING') end
    local row = cjson.decode(currentRaw)
    if row.status == 'queued' and row.from and row.from.kind == 'user' then
      queuedUserSources[row.payload.sourceRecordId] = true
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
  if incoming[i].row.kind == 'private_input' then
    redis.call('HSET', privateAdmissionsKey, incoming[i].id, incoming[i].fingerprint)
  end
end
for messageId, update in pairs(messageIndexUpdates) do
  redis.call('HSET', KEYS[3], messageId, cjson.encode(update.ids))
end
return 1
`;
