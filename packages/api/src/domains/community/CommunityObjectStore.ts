/**
 * CommunityObjectStore — Redis-backed projection store (F168 Phase A)
 *
 * Stores serialised CommunityObjectProjection at:
 *   community:object:{subjectKey}   → STRING (JSON)
 *   community:objects:index         → SET (all subjectKeys with projections)
 *
 * TTL is never set (铁律 #5 / LL-048 — user-traceable state is persistent).
 */

import { type CommunityObjectProjection, canonicalizeCommunitySubjectKey } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { CommunityKeys } from './community-keys.js';

const MIGRATE_PROJECTION_KEY_LUA = `
local canonical = redis.call('GET', KEYS[1])
if canonical then return canonical end
-- Eligible legacy keys are supplied in code-unit subject order. Choose the
-- first live value atomically; stale index members cannot hide later values.
for i = 3, #KEYS do
  local legacy = redis.call('GET', KEYS[i])
  if legacy then
    local projection = cjson.decode(legacy)
    projection.subjectKey = ARGV[1]
    local migrated = cjson.encode(projection)
    redis.call('SET', KEYS[1], migrated)
    redis.call('SADD', KEYS[2], ARGV[1])
    redis.call('DEL', KEYS[i])
    redis.call('SREM', KEYS[2], ARGV[i - 1])
    return migrated
  end
end
return false
`;

export interface ICommunityObjectStore {
  get(subjectKey: string): Promise<CommunityObjectProjection | null>;
  save(projection: CommunityObjectProjection): Promise<void>;
  listSubjectKeys(): Promise<string[]>;
  delete(subjectKey: string): Promise<void>;
}

export class RedisCommunityObjectStore implements ICommunityObjectStore {
  constructor(private readonly redis: RedisClient) {}

  async get(subjectKey: string): Promise<CommunityObjectProjection | null> {
    const canonical = canonicalizeCommunitySubjectKey(subjectKey);
    const canonicalRaw = await this.redis.get(CommunityKeys.objectProjection(canonical));
    if (canonicalRaw) return JSON.parse(canonicalRaw) as CommunityObjectProjection;

    const legacyKeys = (await this.redis.smembers(CommunityKeys.objectsIndex))
      .filter((candidate) => candidate !== canonical && canonicalizeCommunitySubjectKey(candidate) === canonical)
      .sort();
    if (legacyKeys.length === 0) return null;
    // All current writers save canonical keys. Choose among this legacy snapshot
    // in one transaction: a concurrent canonical save wins; otherwise the first
    // live alias in code-unit order moves. Unselected aliases remain untouched.
    const migrated = await this.redis.eval(
      MIGRATE_PROJECTION_KEY_LUA,
      2 + legacyKeys.length,
      CommunityKeys.objectProjection(canonical),
      CommunityKeys.objectsIndex,
      ...legacyKeys.map(CommunityKeys.objectProjection),
      canonical,
      ...legacyKeys,
    );
    return migrated ? (JSON.parse(String(migrated)) as CommunityObjectProjection) : null;
  }

  async save(projection: CommunityObjectProjection): Promise<void> {
    const subjectKey = canonicalizeCommunitySubjectKey(projection.subjectKey);
    const canonicalProjection = subjectKey === projection.subjectKey ? projection : { ...projection, subjectKey };
    await this.redis.set(CommunityKeys.objectProjection(subjectKey), JSON.stringify(canonicalProjection));
    await this.redis.sadd(CommunityKeys.objectsIndex, subjectKey);
    if (subjectKey !== projection.subjectKey) {
      await this.redis.del(CommunityKeys.objectProjection(projection.subjectKey));
      await this.redis.srem(CommunityKeys.objectsIndex, projection.subjectKey);
    }
  }

  async listSubjectKeys(): Promise<string[]> {
    return this.redis.smembers(CommunityKeys.objectsIndex);
  }

  async delete(subjectKey: string): Promise<void> {
    const canonical = canonicalizeCommunitySubjectKey(subjectKey);
    await this.redis.del(CommunityKeys.objectProjection(canonical));
    await this.redis.srem(CommunityKeys.objectsIndex, canonical);
    if (canonical !== subjectKey) {
      await this.redis.del(CommunityKeys.objectProjection(subjectKey));
      await this.redis.srem(CommunityKeys.objectsIndex, subjectKey);
    }
  }
}
