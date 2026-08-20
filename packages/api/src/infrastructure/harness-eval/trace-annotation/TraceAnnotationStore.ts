import type { TraceAnnotation } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const ANNOTATION_PREFIX = 'trace-annotation:';
const INCIDENT_PREFIX = 'trace-annotation-incident:';
const METRIC_INDEX_PREFIX = 'trace-annotation-metric-index:';

const annotationKey = (annotationId: string) => `${ANNOTATION_PREFIX}${annotationId}`;
const incidentKey = (annotation: TraceAnnotation) =>
  `${INCIDENT_PREFIX}${annotation.episodeRef.ownerUserId}:${annotation.objectiveId}:${annotation.metricId}:${annotation.incidentKey}`;
const metricIndexKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${METRIC_INDEX_PREFIX}${ownerUserId}:${objectiveId}:${metricId}`;
const sequenceKey = (ownerUserId: string, objectiveId: string) =>
  `harness-annotation-seq:${ownerUserId}:${objectiveId}`;

/**
 * F257 R11: compare two annotations for canonical equality, ignoring the
 * store-assigned sequence. Object keys are sorted so equivalent maps produce
 * the same comparison regardless of insertion order.
 */
function canonicalEqual(left: TraceAnnotation, right: TraceAnnotation): boolean {
  return deepEqualIgnoringSequence(left, right);
}

function deepEqualIgnoringSequence(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!deepEqualIgnoringSequence(left[index], right[index])) return false;
    }
    return true;
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord)
      .filter((key) => key !== 'sequence')
      .sort();
    const rightKeys = Object.keys(rightRecord)
      .filter((key) => key !== 'sequence')
      .sort();
    if (leftKeys.length !== rightKeys.length) return false;
    for (let index = 0; index < leftKeys.length; index++) {
      const key = leftKeys[index];
      if (rightKeys[index] !== key) return false;
      if (!deepEqualIgnoringSequence(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * F257 R12: append annotation atomically through a single Redis Lua script.
 * The script claims the incident alias, verifies annotationId identity (retry
 * vs conflict), assigns a monotonic sequence, writes the annotation, and adds
 * it to the metric index. Either all of these happen, or none happen.
 */
export class TraceAnnotationStore {
  constructor(private readonly redis: RedisClient) {}

  private static readonly APPEND_ANNOTATION_LUA = `
-- @fake-redis-handler: appendAnnotation
local incidentKey = KEYS[1]
local annotationKey = KEYS[2]
local sequenceKey = KEYS[3]
local metricIndexKey = KEYS[4]

local annotationId = ARGV[1]
local incidentValue = ARGV[2]
local canonicalJson = ARGV[3]
local createdAt = ARGV[4]

local function stripSequence(json)
  return json:gsub(',"sequence":%d+%}$', '}')
end

local function isOk(reply)
  return reply == 'OK' or (type(reply) == 'table' and reply.ok == 'OK')
end

-- Claim the incident-to-annotation alias. A different incidentKey for the same
-- annotationId is allowed to race; the identity check below decides the winner.
local claimed = redis.call('SET', incidentKey, incidentValue, 'NX')
if not isOk(claimed) then
  local existing = redis.call('GET', annotationKey)
  if existing then
    if stripSequence(existing) == canonicalJson then
      return {'duplicate', annotationId}
    else
      return {'conflict', annotationId}
    end
  end
  -- Incident claimed but annotation not yet written: we cannot verify identity.
  -- Reject rather than silently duplicate.
  return {'conflict', annotationId}
end

local existing = redis.call('GET', annotationKey)
if existing then
  if stripSequence(existing) == canonicalJson then
    return {'duplicate', annotationId}
  else
    -- Roll back the incident alias we just claimed; this annotationId is immutable.
    redis.call('DEL', incidentKey)
    return {'conflict', annotationId}
  end
end

local seq = redis.call('INCR', sequenceKey)
-- Keep the sequence field last so stored JSON stays stable and stripSequence works.
local fullJson = string.sub(canonicalJson, 1, -2) .. ',"sequence":' .. seq .. '}'
redis.call('SET', annotationKey, fullJson)
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

    const canonicalJson = JSON.stringify(annotation);
    const result = (await (this.redis as RedisClient & { eval: EvalLike }).eval(
      TraceAnnotationStore.APPEND_ANNOTATION_LUA,
      4,
      incidentKey(annotation),
      annotationKey(annotation.annotationId),
      sequenceKey(annotation.episodeRef.ownerUserId, annotation.objectiveId),
      metricIndexKey(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.metricId),
      annotation.annotationId,
      annotation.annotationId,
      canonicalJson,
      String(annotation.createdAt),
    )) as [string, string, string?];

    const [outcome, annotationId] = result;
    if (outcome === 'conflict') {
      throw new Error(`trace_annotation_conflict:${annotationId}`);
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

    const existingRaw = await this.redis.get(annotationKey(annotation.annotationId));
    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as TraceAnnotation;
      if (!canonicalEqual(annotation, existing)) {
        if (claimed === 'OK') {
          await this.redis.del(canonicalIncidentKey);
        }
        throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
      }
      await this.redis.zadd(
        metricIndexKey(ownerUserId, objectiveId, existing.metricId),
        existing.createdAt,
        existing.annotationId,
      );
      return { outcome: 'duplicate', annotationId: existing.annotationId };
    }

    const sequence = Number(await this.redis.incr(sequenceKey(ownerUserId, objectiveId)));
    const scored = { ...annotation, sequence };

    const serialized = JSON.stringify(scored);
    const created = await this.redis.set(annotationKey(scored.annotationId), serialized, 'NX');
    if (created !== 'OK') {
      const raced = await this.redis.get(annotationKey(scored.annotationId));
      if (!raced) throw new Error(`trace_annotation_race_lost:${scored.annotationId}`);
      const racedAnnotation = JSON.parse(raced) as TraceAnnotation;
      if (!canonicalEqual(annotation, racedAnnotation)) {
        if (claimed === 'OK') {
          await this.redis.del(canonicalIncidentKey);
        }
        throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
      }
      await this.redis.zadd(
        metricIndexKey(ownerUserId, objectiveId, racedAnnotation.metricId),
        racedAnnotation.createdAt,
        racedAnnotation.annotationId,
      );
      return { outcome: 'duplicate', annotationId: racedAnnotation.annotationId };
    }

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
