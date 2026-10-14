/** Read-only, one hash snapshot: never transfer an excluded cat's body/tool/extra payload. */
export const HUMAN_SOURCE_HASH_LUA = `
local catId = redis.call('HGET', KEYS[1], 'catId')
if not catId or catId == '' then
  return redis.call('HGETALL', KEYS[1])
end
local fields = {'id', 'catId', 'deletedAt', 'queueCustody', 'queueCustodyAdmission'}
local result = {}
for _, field in ipairs(fields) do
  local value = redis.call('HGET', KEYS[1], field)
  if value then
    table.insert(result, field)
    table.insert(result, value)
  end
end
return result
`;

/** Lua returns alternating field/value strings, matching the native HGETALL snapshot. */
export function humanSourceHash(raw: unknown): Record<string, string> | null {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const hash: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key: unknown = raw[i];
    const value: unknown = raw[i + 1];
    if (typeof key !== 'string' || typeof value !== 'string') return null;
    Object.defineProperty(hash, key, { value, enumerable: true, configurable: true });
  }
  return hash;
}
