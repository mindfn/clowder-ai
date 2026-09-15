import type { RedisClient } from '@cat-cafe/shared/utils';
import { artifactOwnerKey } from './artifact-store/artifact-store-layout.js';
import { type EvalLifecycleEvent, EvalLifecycleEventSchema } from './reeval-closure-schema.js';

const KEYSPACE = 'eval:verdict-lifecycle';

/**
 * Which lifecycle an event log records. Lifecycle ids (verdict ids, and case ids
 * derived from domain + finding) are not unique across owners, so the owner is part
 * of the log's address rather than a field on its events:
 *
 * - `repository` — lifecycles of roots committed to the product repository. Keeps the
 *   original global keys, so state recorded before owner partitions stays readable.
 * - `owner` — lifecycles of the runtime artifacts one owner published, under the same
 *   owner key as that owner's artifact partition. Log, duplicate set and subject index
 *   are all per owner: two owners never share a sequence, an event id, or a listing.
 */
export type EvalLifecycleScope = { kind: 'repository' } | { kind: 'owner'; ownerUserId: string };

export const REPOSITORY_LIFECYCLE_SCOPE: EvalLifecycleScope = { kind: 'repository' };

export function reevalClosureKeys(scope: EvalLifecycleScope) {
  const prefix = scope.kind === 'repository' ? KEYSPACE : `${KEYSPACE}:owners:${artifactOwnerKey(scope.ownerUserId)}`;
  return {
    eventLog: (subjectId: string): string => `${prefix}:log:${subjectId}`,
    eventsSeen: `${prefix}:events:seen`,
    verdicts: `${prefix}:verdicts`,
  } as const;
}

export const ReevalClosureKeys = reevalClosureKeys(REPOSITORY_LIFECYCLE_SCOPE);

export type ReevalClosureAppendResult =
  | { outcome: 'appended'; sequence: number }
  | { outcome: 'duplicate' }
  | { outcome: 'conflict'; actualSequence: number };

export interface IReevalClosureEventLog {
  append(event: EvalLifecycleEvent, expectedSequence: number): Promise<ReevalClosureAppendResult>;
  read(subjectId: string, fromSequence?: number): Promise<EvalLifecycleEvent[]>;
  listVerdictIds(): Promise<string[]>;
  listSubjectIds(): Promise<string[]>;
}

function lifecycleSubjectId(event: EvalLifecycleEvent): string {
  return event.caseId ?? event.verdictId;
}

/**
 * KEYS: subject log, global seen set, verdict index.
 * ARGV: event id, expected LLEN, encoded event, verdict id.
 *
 * Duplicate detection intentionally precedes the sequence comparison so a
 * retry remains idempotent even after later lifecycle events have landed.
 */
const APPEND_LUA = `
local already = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if already == 1 then
  return {0, -1}
end

local current = redis.call('LLEN', KEYS[1])
if current ~= tonumber(ARGV[2]) then
  return {-1, current}
end

redis.call('SADD', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('RPUSH', KEYS[1], ARGV[3])
return {1, current}
`;

function requireSequence(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export class RedisReevalClosureEventLog implements IReevalClosureEventLog {
  private readonly keys: ReturnType<typeof reevalClosureKeys>;

  constructor(
    private readonly redis: RedisClient,
    scope: EvalLifecycleScope = REPOSITORY_LIFECYCLE_SCOPE,
  ) {
    this.keys = reevalClosureKeys(scope);
  }

  async append(event: EvalLifecycleEvent, expectedSequence: number): Promise<ReevalClosureAppendResult> {
    requireSequence(expectedSequence, 'expectedSequence');
    const validated = EvalLifecycleEventSchema.parse(event);
    const subjectId = lifecycleSubjectId(validated);
    const result = (await this.redis.eval(
      APPEND_LUA,
      3,
      this.keys.eventLog(subjectId),
      this.keys.eventsSeen,
      this.keys.verdicts,
      validated.eventId,
      expectedSequence.toString(),
      JSON.stringify(validated),
      subjectId,
    )) as [number, number];

    if (result[0] === 0) return { outcome: 'duplicate' };
    if (result[0] === -1) return { outcome: 'conflict', actualSequence: result[1] };
    return { outcome: 'appended', sequence: result[1] };
  }

  async read(subjectId: string, fromSequence = 0): Promise<EvalLifecycleEvent[]> {
    requireSequence(fromSequence, 'fromSequence');
    const raw = await this.redis.lrange(this.keys.eventLog(subjectId), fromSequence, -1);
    return raw.map((encoded) => EvalLifecycleEventSchema.parse(JSON.parse(encoded)));
  }

  async listVerdictIds(): Promise<string[]> {
    return (await this.redis.smembers(this.keys.verdicts)).sort();
  }

  async listSubjectIds(): Promise<string[]> {
    return this.listVerdictIds();
  }
}
