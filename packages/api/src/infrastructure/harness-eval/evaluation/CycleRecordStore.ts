import { createHash } from 'node:crypto';
import type { CycleRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const CURRENT_PREFIX = 'harness-cycle-current:';
const HISTORY_PREFIX = 'harness-cycle-history:';
const HISTORY_INDEX_PREFIX = 'harness-cycle-history-index:';
const OWNER_REGISTRY_KEY = 'harness-cycle-owner-registry';
const LEGACY_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';

const coordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const currentKey = (ownerUserId: string, objectiveId: string) =>
  `${CURRENT_PREFIX}${coordinate(ownerUserId, objectiveId)}`;
const historyKey = (ownerUserId: string, objectiveId: string, cycleId: string) =>
  `${HISTORY_PREFIX}${coordinate(ownerUserId, objectiveId)}:${cycleId}`;
const historyIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${HISTORY_INDEX_PREFIX}${coordinate(ownerUserId, objectiveId)}`;

const CAS_CURRENT_LUA = `
-- @fake-redis-handler: casHarnessCycleCurrent
local current = redis.call('GET', KEYS[1])
if current == false then return 0 end
local decoded, cycle = pcall(cjson.decode, current)
if not decoded or cycle.cycleId ~= ARGV[1] or cycle.evalStatus ~= 'idle' then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function cycleId(ownerUserId: string, objectiveId: string, cycleStart: number): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([ownerUserId, objectiveId, cycleStart]))
    .digest('hex');
  return `cycle-${hash}`;
}

function parseCycle(raw: string, key: string): CycleRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid_cycle_record:${key}`);
  }
  const record = value as Partial<CycleRecord>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.cycleId !== 'string' ||
    typeof record.ownerUserId !== 'string' ||
    typeof record.objectiveId !== 'string' ||
    typeof record.version !== 'string' ||
    typeof record.versionContentRef !== 'string' ||
    typeof record.cycleStart !== 'number' ||
    !Number.isFinite(record.cycleStart) ||
    record.cycleStart < 0 ||
    !Array.isArray(record.windows) ||
    !record.windows.every(
      (window) =>
        Number.isFinite(window.start) && Number.isFinite(window.end) && window.start >= 0 && window.end >= window.start,
    ) ||
    !['idle', 'requested', 'retriggered', 'written', 'stalled'].includes(record.evalStatus ?? '')
  ) {
    throw new Error(`invalid_cycle_record:${key}`);
  }
  return record as CycleRecord;
}

export class CycleRecordStore {
  constructor(private readonly redis: RedisClient) {}

  async current(ownerUserId: string, objectiveId: string): Promise<CycleRecord | null> {
    const key = currentKey(ownerUserId, objectiveId);
    const raw = await this.redis.get(key);
    return raw ? parseCycle(raw, key) : null;
  }

  async initialize(
    ownerUserId: string,
    objectiveId: string,
    cycleStart: number,
    version: Pick<CycleRecord, 'version' | 'versionContentRef'>,
  ): Promise<CycleRecord> {
    if (!Number.isFinite(cycleStart) || cycleStart < 0) throw new Error('invalid_cycle_start');
    const record: CycleRecord = {
      schemaVersion: 1,
      cycleId: cycleId(ownerUserId, objectiveId, cycleStart),
      ownerUserId,
      objectiveId,
      ...version,
      cycleStart,
      evalStatus: 'idle',
      windows: [],
    };
    await this.redis.set(currentKey(ownerUserId, objectiveId), JSON.stringify(record), 'NX');
    await this.redis.sadd(OWNER_REGISTRY_KEY, ownerUserId);
    return (await this.current(ownerUserId, objectiveId)) ?? record;
  }

  async request(expected: CycleRecord, requested: CycleRecord): Promise<boolean> {
    if (expected.evalStatus !== 'idle' || requested.evalStatus !== 'requested') return false;
    if (
      expected.ownerUserId !== requested.ownerUserId ||
      expected.objectiveId !== requested.objectiveId ||
      expected.cycleId !== requested.cycleId
    ) {
      return false;
    }
    const serialized = JSON.stringify(requested);
    const changed = (await this.redis.eval(
      CAS_CURRENT_LUA,
      1,
      currentKey(expected.ownerUserId, expected.objectiveId),
      expected.cycleId,
      serialized,
    )) as number;
    return changed === 1;
  }

  async history(ownerUserId: string, objectiveId: string): Promise<CycleRecord[]> {
    const ids = await this.redis.zrevrange(historyIndexKey(ownerUserId, objectiveId), 0, -1);
    const records: CycleRecord[] = [];
    for (const id of ids) {
      const key = historyKey(ownerUserId, objectiveId, id);
      const raw = await this.redis.get(key);
      if (!raw) throw new Error(`cycle_history_record_missing:${id}`);
      records.push(parseCycle(raw, key));
    }
    return records;
  }

  async ownerUserIds(): Promise<string[]> {
    return (await this.redis.smembers(OWNER_REGISTRY_KEY)).sort();
  }

  async legacyCompletedWindowEnd(ownerUserId: string, objectiveId: string): Promise<number | null> {
    const key = `${LEGACY_COMPLETED_WINDOW_END_PREFIX}${coordinate(ownerUserId, objectiveId)}`;
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_legacy_completed_window_end:${key}`);
    return value;
  }
}

export function isSkippedCycle(record: CycleRecord): boolean {
  return record.approval?.state === 'skipped' || record.evaluation?.overall === 'insufficient_evidence';
}
