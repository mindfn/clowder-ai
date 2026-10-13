import { USER_MENTION_INDEX_LUA } from './user-mention-index-lua.js';

const HANDLING_KEYS_LUA = `
checkMentionKeys({KEYS[1], KEYS[2], KEYS[3]})
for _, key in ipairs({KEYS[5], KEYS[6]}) do
  local kind=redis.call('TYPE',key).ok
  if kind ~= 'none' and kind ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
end
`;

/** The count projection and undo writer use exactly the same source/state qualification. */
const UNDO_ELIGIBILITY_LUA = `
local function canUndoMention(row, keys, prefix, expectedOwner)
  local kind, id, thread, owner = mentionEvent(prefix .. 'msg:' .. row.messageId)
  return kind == 'request' and id == row.messageId and owner == expectedOwner and thread == row.threadId and
    redis.call('HGET',keys[3],thread) == row.closedAfter and redis.call('HGET',keys[1],thread) == id and
    not redis.call('ZSCORE',keys[2],thread) and mentionRevision(keys,thread) == row.revision
end
`;

/** Pure atomic projection; zero remaining does not consume the owner's receipt. */
export const READ_LAST_USER_MENTION_HANDLING_LUA = `${USER_MENTION_INDEX_LUA}${UNDO_ELIGIBILITY_LUA}
checkMentionKeys({KEYS[1],KEYS[2],KEYS[3]})
local id=redis.call('HGET',KEYS[4],ARGV[1])
if not id then return false end
local raw=redis.call('GET',ARGV[2] .. 'msg:user-requests:undo:' .. ARGV[1] .. ':' .. id)
if not raw then return false end
local rows=cjson.decode(raw)
local remaining=0
for _, row in ipairs(rows) do
  checkMentionKeys({KEYS[1],KEYS[2],KEYS[3],ARGV[2] .. 'msg:user-request-signals:' .. ARGV[1] .. ':' .. row.threadId})
  if canUndoMention(row,KEYS,ARGV[2],ARGV[1]) then remaining=remaining+1 end
end
return {id,#rows,remaining}
`;

/** Validate every exact source/state before any write; persistent receipt contains refs only. */
export const HANDLE_USER_MENTIONS_LUA = `${USER_MENTION_INDEX_LUA}${HANDLING_KEYS_LUA}
local rows = cjson.decode(ARGV[1])
local saved = {}
local seen = {}
for _, row in ipairs(rows) do
  if seen[row.threadId] then return false end
  seen[row.threadId] = true
  local signals=ARGV[2] .. 'msg:user-request-signals:' .. ARGV[3] .. ':' .. row.threadId
  checkMentionKeys({KEYS[1], KEYS[2], KEYS[3], signals})
  local revision=mentionRevision(KEYS,row.threadId)
  local restored=redis.call('HGET',mentionAux(KEYS,'restored'),row.threadId) or ''
  if (row.expectedRevision and row.expectedRevision ~= revision) or (not row.expectedRevision and restored ~= '') then return false end
  local kind, id, thread, owner = mentionEvent(ARGV[2] .. 'msg:' .. row.messageId)
  if kind ~= 'request' or owner ~= ARGV[3] or thread ~= row.threadId or
    redis.call('HGET', KEYS[1], thread) ~= id or not redis.call('ZSCORE', KEYS[2], thread) then return false end
  local previous=redis.call('HGET',KEYS[3],thread) or ''
  table.insert(saved, {threadId=thread, messageId=id, previous=previous, previousRestored=restored,
    closedAfter=previous > id and previous or id, revision=revision+1, candidates=redis.call('ZRANGE',signals,0,-1)})
end
if #saved == 0 or redis.call('EXISTS', KEYS[4]) == 1 then return false end
local oldReceipt=redis.call('HGET',KEYS[6],ARGV[3])
for _, row in ipairs(saved) do
  redis.call('HSET', KEYS[5], row.messageId, row.threadId)
  redis.call('HSET', KEYS[3], row.threadId, row.closedAfter)
  redis.call('HDEL',mentionAux(KEYS,'restored'),row.threadId)
  bumpMentionRevision(KEYS,row.threadId)
  redis.call('ZREM', KEYS[2], row.threadId)
  redis.call('ZREMRANGEBYLEX', ARGV[2] .. 'msg:user-request-signals:' .. ARGV[3] .. ':' .. row.threadId, '-', '[' .. row.closedAfter)
end
if oldReceipt then redis.call('DEL',ARGV[2] .. 'msg:user-requests:undo:' .. ARGV[3] .. ':' .. oldReceipt) end
redis.call('SET', KEYS[4], cjson.encode(saved))
redis.call('HSET',KEYS[6],ARGV[3],ARGV[4])
return #saved
`;

/** Undo only unchanged post-handle versions: restore/rehandle of the same source cannot create ABA. */
export const UNDO_USER_MENTIONS_LUA = `${USER_MENTION_INDEX_LUA}${HANDLING_KEYS_LUA}${UNDO_ELIGIBILITY_LUA}
local raw = redis.call('GET', KEYS[4])
if not raw then return false end
local rows = cjson.decode(raw)
local restored = 0
for _, row in ipairs(rows) do
  checkMentionKeys({KEYS[1], KEYS[2], KEYS[3], ARGV[1] .. 'msg:user-request-signals:' .. ARGV[2] .. ':' .. row.threadId})
end
for _, row in ipairs(rows) do
  if canUndoMention(row,KEYS,ARGV[1],ARGV[2]) then
    local id,thread=row.messageId,row.threadId
    if row.previous == '' then redis.call('HDEL', KEYS[3], thread)
    else redis.call('HSET', KEYS[3], thread, row.previous) end
    if row.previousRestored == '' then redis.call('HDEL',mentionAux(KEYS,'restored'),thread)
    else redis.call('HSET',mentionAux(KEYS,'restored'),thread,row.previousRestored) end
    bumpMentionRevision(KEYS,thread)
    redis.call('ZADD', KEYS[2], 0, thread)
    for _, candidate in ipairs(row.candidates) do redis.call('ZADD', ARGV[1] .. 'msg:user-request-signals:' .. ARGV[2] .. ':' .. thread, 0, candidate) end
    redis.call('HDEL',KEYS[5],id)
    restored = restored + 1
  end
end
redis.call('DEL', KEYS[4])
return restored
`;

/** Preserve legacy manual closes once; later restores must never be migrated back into history. */
export const MIGRATE_HANDLED_USER_MENTIONS_LUA = `${USER_MENTION_INDEX_LUA}
for _, key in ipairs({KEYS[1],KEYS[2],KEYS[3]}) do
  local kind=redis.call('TYPE',key).ok
  if kind ~= 'none' and kind ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
end
if redis.call('HGET',KEYS[3],ARGV[2]) then return 0 end
local rows=redis.call('HGETALL',KEYS[1])
for i=1,#rows,2 do
  local event,id,thread,owner=mentionEvent(ARGV[1] .. 'msg:' .. rows[i+1])
  if event == 'request' and owner == ARGV[2] and thread == rows[i] then redis.call('HSET',KEYS[2],id,thread) end
end
redis.call('HSET',KEYS[3],ARGV[2],'1')
return 1
`;

export const RESTORE_USER_MENTION_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[1],KEYS[2],KEYS[3],KEYS[4]})
local historyType=redis.call('TYPE',KEYS[5]).ok
if historyType ~= 'none' and historyType ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
local kind,id,thread,owner=mentionEvent(ARGV[1] .. 'msg:' .. ARGV[4])
if kind ~= 'request' or owner ~= ARGV[2] or thread ~= ARGV[3] or redis.call('HGET',KEYS[5],id) ~= thread or
  redis.call('ZSCORE',KEYS[2],thread) or mentionRevision(KEYS,thread) ~= tonumber(ARGV[5]) then return 0 end
redis.call('HSET',mentionAux(KEYS,'restored'),thread,id)
redis.call('HSET',KEYS[1],thread,id)
redis.call('ZADD',KEYS[2],0,thread)
redis.call('ZADD',KEYS[4],0,id)
redis.call('HDEL',KEYS[5],id)
bumpMentionRevision(KEYS,thread)
return 1
`;
