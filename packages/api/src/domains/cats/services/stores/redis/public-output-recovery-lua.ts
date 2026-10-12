/** Checkpoint is storage-owned and persistent; exact bytes fence concurrent sweep owners. */
export const PUBLIC_OUTPUT_CHECKPOINT_LUA = `
local actual = redis.call('GET', KEYS[1]) or ''
if actual ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

/** Full raw fence, then deletion + index retirement. No Lua JSON re-encoding:
 * cjson would change empty arrays inside unrelated extra into objects.
 * All validation and key-type checks precede the first write.
 */
export const PUBLIC_OUTPUT_DELETE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local expected = cjson.decode(ARGV[1])
if redis.call('HLEN', KEYS[1]) ~= #expected then return {0} end
for _, pair in ipairs(expected) do
  if redis.call('HGET', KEYS[1], pair[1]) ~= pair[2] then return {0} end
end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('PUBLIC_OUTPUT_INDEX_TYPE') end
if ARGV[3] == 'hard' then
  redis.call('HSET', KEYS[1], 'content', '', 'contentBlocks', '', 'toolEvents', '', 'metadata', '', 'extra', '',
    'pluginMessage', '', 'custodyOfferV1', '', 'lifecycle', '', 'thinking', '', 'mentions', '[]', '_tombstone', '1')
elseif ARGV[6] ~= '' then
  redis.call('HSET', KEYS[1], 'extra', ARGV[6])
end
redis.call('HSET', KEYS[1], 'deletedAt', ARGV[4], 'deletedBy', ARGV[5])
redis.call('ZREM', KEYS[2], ARGV[2])
local result = {1}
for _, value in ipairs(redis.call('HGETALL', KEYS[1])) do table.insert(result, value) end
return result
`;

/** Thread membership is read and deleted in the same operation, including recovery membership.
 * A concurrent append is ordered before or after this whole deletion, never lost between scan and DEL.
 */
export const PUBLIC_OUTPUT_THREAD_DELETE_LUA = `
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('PUBLIC_OUTPUT_INDEX_TYPE') end
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, id in ipairs(ids) do
  redis.call('DEL', ARGV[1] .. 'msg:' .. id)
  redis.call('ZREM', KEYS[2], id)
end
for _, key in ipairs(KEYS) do
  if key ~= KEYS[2] then redis.call('DEL', key) end
end
return #ids
`;

/** Only absence permits cleanup; a recreated row wins and remains discoverable. */
export const PUBLIC_OUTPUT_RETIRE_MISSING_LUA = `
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
return redis.call('ZREM', KEYS[2], ARGV[1])
`;
