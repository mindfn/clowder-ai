import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const ANNOTATION_PREFIX = 'trace-annotation:';
const ANNOTATION_CANONICAL_PREFIX = 'trace-annotation-canonical:';
const INCIDENT_PREFIX = 'trace-annotation-incident:';
const METRIC_INDEX_PREFIX = 'trace-annotation-metric-index:';

const annotationKey = (annotationId: string) => `${ANNOTATION_PREFIX}${annotationId}`;
const annotationCanonicalKey = (annotationId: string) => `${ANNOTATION_CANONICAL_PREFIX}${annotationId}`;
const incidentKey = (annotation: TraceAnnotation) =>
  `${INCIDENT_PREFIX}${annotation.episodeRef.ownerUserId}:${annotation.objectiveId}:${annotation.metricId}:${annotation.incidentKey}`;
const metricIndexKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${METRIC_INDEX_PREFIX}${ownerUserId}:${objectiveId}:${metricId}`;
const sequenceKey = (ownerUserId: string, objectiveId: string) =>
  `harness-annotation-seq:${ownerUserId}:${objectiveId}`;

/**
 * F257 R13: stable canonical JSON representation of an annotation, excluding
 * the store-assigned sequence and sorting object keys recursively. This is the
 * identity contract used for both the Lua atomic path and the sequential test
 * fallback.
 */
function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => key !== 'sequence')
    .sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * F257 R13: append annotation atomically through a single Redis Lua script.
 * The script preflights key types, claims the incident alias (authoritative
 * identity), verifies annotationId payload, assigns a monotonic sequence,
 * writes the annotation + canonical digest, and adds it to the metric index.
 * Either all of these happen, or none happen.
 */
export class TraceAnnotationStore {
  constructor(private readonly redis: RedisClient) {}

  private static readonly APPEND_ANNOTATION_LUA = `
-- @fake-redis-handler: appendAnnotation
local incidentKey = KEYS[1]
local annotationKey = KEYS[2]
local canonicalKey = KEYS[3]
local sequenceKey = KEYS[4]
local metricIndexKey = KEYS[5]

local annotationId = ARGV[1]
local incidentValue = ARGV[2]
local canonicalJson = ARGV[3]
local createdAt = ARGV[4]

local function isOk(reply)
  return reply == 'OK' or (type(reply) == 'table' and reply.ok == 'OK')
end

local function redisType(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply.ok end
  return reply
end

local function checkOrError(key, expected)
  local actual = redisType(key)
  if actual == 'none' then return true end
  for _, allowed in ipairs(expected) do
    if actual == allowed then return true end
  end
  return false
end

-- Preflight every key we are about to touch so a WRONGTYPE cannot leave a
-- half-written annotation record.
if not checkOrError(incidentKey, {'string'}) then
  return {'error', 'trace_annotation_preflight_failed:incident_key_wrong_type'}
end
if not checkOrError(annotationKey, {'string'}) then
  return {'error', 'trace_annotation_preflight_failed:annotation_key_wrong_type'}
end
if not checkOrError(canonicalKey, {'string'}) then
  return {'error', 'trace_annotation_preflight_failed:canonical_key_wrong_type'}
end
if not checkOrError(sequenceKey, {'string'}) then
  return {'error', 'trace_annotation_preflight_failed:sequence_key_wrong_type'}
end
if not checkOrError(metricIndexKey, {'zset'}) then
  return {'error', 'trace_annotation_preflight_failed:metric_index_wrong_type'}
end

-- Claim the incident-to-annotation alias. If the alias already exists, it is
-- the authoritative identity: return the annotationId it points to.
local claimed = redis.call('SET', incidentKey, incidentValue, 'NX')
if not isOk(claimed) then
  local existingAnnotationId = redis.call('GET', incidentKey)
  if existingAnnotationId and existingAnnotationId ~= annotationId then
    return {'duplicate', existingAnnotationId}
  end
  if existingAnnotationId == annotationId then
    return {'duplicate', annotationId}
  end
  -- Alias disappeared between SET and GET; fall through to annotation key check.
end

-- Annotation already exists: compare stable canonical digests.
local existingCanonical = redis.call('GET', canonicalKey)
if existingCanonical then
  if existingCanonical == canonicalJson then
    return {'duplicate', annotationId}
  end
  -- Conflict: roll back the incident alias we just claimed (if any).
  if isOk(claimed) then
    redis.call('DEL', incidentKey)
  end
  return {'conflict', annotationId}
end

local seq = redis.call('INCR', sequenceKey)
-- Append sequence to the stable canonical JSON before the closing brace.
local fullJson = string.sub(canonicalJson, 1, -2) .. ',"sequence":' .. seq .. '}'
redis.call('SET', annotationKey, fullJson)
redis.call('SET', canonicalKey, canonicalJson)
redis.call('ZADD', metricIndexKey, createdAt, annotationId)
return {'created', annotationId, tostring(seq)}
`;

  async append(annotation: TraceAnnotation): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
    // Production Redis provides EVAL; test stubs without it fall back to a
    // sequential implementation. The real-Redis regression suite exercises the
    // atomic Lua path.
    if (typeof (this.redis as RedisClient & { eval?: unknown }).eval !== 'function') {
      return this.appendWithFallback(annotation);
    }

    const canonical = canonicalJson(annotation);
    const result = (await (this.redis as RedisClient & { eval: EvalLike }).eval(
      TraceAnnotationStore.APPEND_ANNOTATION_LUA,
      5,
      incidentKey(annotation),
      annotationKey(annotation.annotationId),
      annotationCanonicalKey(annotation.annotationId),
      sequenceKey(annotation.episodeRef.ownerUserId, annotation.objectiveId),
      metricIndexKey(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.metricId),
      annotation.annotationId,
      annotation.annotationId,
      canonical,
      String(annotation.createdAt),
    )) as [string, string, string?];

    const [outcome, annotationId] = result;
    if (outcome === 'error' || outcome === 'conflict') {
      throw new Error(
        `${outcome === 'error' ? 'trace_annotation_preflight_failed' : 'trace_annotation_conflict'}:${annotationId}`,
      );
    }
    return { outcome: outcome as 'created' | 'duplicate', annotationId };
  }

  /**
   * Non-atomic fallback used only by test stubs that do not implement EVAL.
   * Keeps the same identity semantics (retry vs conflict) for serial tests.
   */
  private async appendWithFallback(
    annotation: TraceAnnotation,
  ): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
    const canonicalIncidentKey = incidentKey(annotation);
    const claimed = await this.redis.set(canonicalIncidentKey, annotation.annotationId, 'NX');
    if (claimed !== 'OK') {
      const existingId = await this.redis.get(canonicalIncidentKey);
      if (!existingId) throw new Error(`trace_annotation_incident_claim_lost:${annotation.incidentKey}`);
      if (existingId !== annotation.annotationId) return { outcome: 'duplicate', annotationId: existingId };
    }

    const ownerUserId = annotation.episodeRef.ownerUserId;
    const objectiveId = annotation.objectiveId;
    const metricId = annotation.metricId;

    const existingCanonical = await this.redis.get(annotationCanonicalKey(annotation.annotationId));
    if (existingCanonical) {
      if (existingCanonical !== canonicalJson(annotation)) {
        if (claimed === 'OK') {
          await this.redis.del(canonicalIncidentKey);
        }
        throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
      }
      return { outcome: 'duplicate', annotationId: annotation.annotationId };
    }

    const sequence = Number(await this.redis.incr(sequenceKey(ownerUserId, objectiveId)));
    const scored = { ...annotation, sequence };

    const serialized = JSON.stringify(scored);
    const created = await this.redis.set(annotationKey(scored.annotationId), serialized, 'NX');
    if (created !== 'OK') {
      const raced = await this.redis.get(annotationKey(scored.annotationId));
      if (!raced) throw new Error(`trace_annotation_race_lost:${scored.annotationId}`);
      if (canonicalJson(JSON.parse(raced)) !== canonicalJson(annotation)) {
        if (claimed === 'OK') {
          await this.redis.del(canonicalIncidentKey);
        }
        throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
      }
      return { outcome: 'duplicate', annotationId: scored.annotationId };
    }

    await this.redis.set(annotationCanonicalKey(scored.annotationId), canonicalJson(scored));
    await this.redis.zadd(metricIndexKey(ownerUserId, objectiveId, metricId), scored.createdAt, scored.annotationId);
    return { outcome: 'created', annotationId: scored.annotationId };
  }

  async get(annotationId: string): Promise<TraceAnnotation | null> {
    const raw = await this.redis.get(annotationKey(annotationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TraceAnnotation;
    } catch {
      return null;
    }
  }

  async queryMetricWindow(
    ownerUserId: string,
    objectiveId: string,
    metricId: string,
    startAt: number,
    endAt: number,
  ): Promise<TraceAnnotation[]> {
    // Half-open score range [startAt, endAt) in annotation createdAt millis. An
    // annotation whose score equals the upper bound belongs to the next Unit run.
    const ids = await this.redis.zrangebyscore(
      metricIndexKey(ownerUserId, objectiveId, metricId),
      String(startAt),
      `(${endAt}`,
    );
    const out: TraceAnnotation[] = [];
    for (const id of ids) {
      const annotation = await this.get(id);
      if (annotation) out.push(annotation);
    }
    return out;
  }
}

type EvalLike = (script: string, numKeys: number, ...args: unknown[]) => Promise<unknown>;
