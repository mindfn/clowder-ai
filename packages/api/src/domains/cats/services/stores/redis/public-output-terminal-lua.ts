/** Full raw-hash fence: no hydration/default/parser can hide a concurrent field change.
 * Preserves every unrelated field, TTL and index. Receipt + boundary share one HSET.
 * Return the canonical hash inside the same atomic operation, including no-op replay.
 */
export const TRANSITION_PUBLIC_OUTPUT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {-1} end
local expected = cjson.decode(ARGV[1])
if redis.call('HLEN', KEYS[1]) ~= #expected then return {0} end
for _, pair in ipairs(expected) do
  if redis.call('HGET', KEYS[1], pair[1]) ~= pair[2] then return {0} end
end
local code = 2
if ARGV[2] ~= '' then
  redis.call('HSET', KEYS[1], 'extra', ARGV[2])
  code = 1
end
local result = {code}
for _, value in ipairs(redis.call('HGETALL', KEYS[1])) do
  table.insert(result, value)
end
return result
`;
