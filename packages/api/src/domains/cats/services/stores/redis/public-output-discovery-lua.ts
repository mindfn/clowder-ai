/** Shared by append, deletion and bounded lookup. All checks run before mutation. */
export const PUBLIC_OUTPUT_DISCOVERY_HELPERS_LUA = `
local function outputHex(value)
  return (string.gsub(value, '.', function(c) return string.format('%02x', string.byte(c)) end))
end
local function outputPrefixes(userId, sourceId, childId)
  return 's:' .. outputHex(userId) .. ':' .. outputHex(sourceId) .. ':',
         'c:' .. outputHex(userId) .. ':' .. outputHex(childId) .. ':'
end
local function outputIndexValid(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return true end
  if kind ~= 'zset' then return false end
  -- Redis lex range semantics require identical scores. Min/max prove that in O(log N).
  local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local last = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  return #first == 0 or (tonumber(first[2]) == 0 and tonumber(last[2]) == 0)
end
`;

/** One atomic observation, two LIMIT 0 2 ranges; never scans/hydrates a thread or returns an unbounded bag. */
export const LOOKUP_PUBLIC_OUTPUT_LUA = `
${PUBLIC_OUTPUT_DISCOVERY_HELPERS_LUA}
if not outputIndexValid(KEYS[1]) then return {'invalid_index'} end
local source, child = outputPrefixes(ARGV[1], ARGV[2], ARGV[3])
local function read(prefix)
  return redis.call('ZRANGEBYLEX', KEYS[1], '[' .. prefix, '(' .. prefix .. '~', 'LIMIT', 0, 2)
end
return {read(source), read(child)}
`;
