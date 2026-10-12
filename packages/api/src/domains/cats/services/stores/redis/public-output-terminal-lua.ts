/** Full raw-hash fence: no hydration/default/parser can hide a concurrent field change.
 * Preserves unrelated fields and TTL. Receipt + boundary + companion/index retirement are atomic.
 * Return the canonical hash inside the same atomic operation, including no-op replay.
 */
export const TRANSITION_PUBLIC_OUTPUT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local expected = cjson.decode(ARGV[1])
if redis.call('HLEN', KEYS[1]) ~= #expected then return {0} end
for _, pair in ipairs(expected) do
  if redis.call('HGET', KEYS[1], pair[1]) ~= pair[2] then return {0} end
end
local indexType = redis.call('TYPE', KEYS[2]).ok
if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('PUBLIC_OUTPUT_INDEX_TYPE') end
local code = 2
if ARGV[2] ~= '' then
  redis.call('HSET', KEYS[1], 'extra', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3])
  code = 1
end
local result = {code}
for _, value in ipairs(redis.call('HGETALL', KEYS[1])) do
  table.insert(result, value)
end
return result
`;
