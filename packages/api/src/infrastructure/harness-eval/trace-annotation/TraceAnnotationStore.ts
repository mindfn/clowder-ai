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
 * F257 R10: the annotation metric index uses the annotation createdAt (ms) as
 * the Redis sorted-set score. Encoding sequence into the same double collapses
 * in production epoch millis (createdAt * SCALE exceeds 2^53); ordering within
 * the same millisecond is recovered by the per-objective monotonic sequence
 * stored on the annotation JSON and by stable sorts in the scheduler.
 */
export function annotationScore(createdAt: number): number {
  return createdAt;
}

export class TraceAnnotationStore {
  constructor(private readonly redis: RedisClient) {}

  async append(annotation: TraceAnnotation): Promise<{ outcome: 'created' | 'duplicate'; annotationId: string }> {
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

    // F257 R10 P1: a retry of the same annotationId must reuse the persisted
    // sequence so the metric index stays deterministic and no conflict is raised.
    const existingRaw = await this.redis.get(annotationKey(annotation.annotationId));
    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as TraceAnnotation;
      await this.redis.zadd(
        metricIndexKey(ownerUserId, objectiveId, existing.metricId),
        annotationScore(existing.createdAt),
        existing.annotationId,
      );
      return { outcome: 'duplicate', annotationId: existing.annotationId };
    }

    const sequence = Number(await this.redis.incr(sequenceKey(ownerUserId, objectiveId)));
    const scored = { ...annotation, sequence };

    const serialized = JSON.stringify(scored);
    const created = await this.redis.set(annotationKey(scored.annotationId), serialized, 'NX');
    if (created !== 'OK') {
      // Another writer won the race between GET and SET; recover its sequence.
      const raced = await this.redis.get(annotationKey(scored.annotationId));
      if (!raced) throw new Error(`trace_annotation_race_lost:${scored.annotationId}`);
      const racedAnnotation = JSON.parse(raced) as TraceAnnotation;
      await this.redis.zadd(
        metricIndexKey(ownerUserId, objectiveId, racedAnnotation.metricId),
        annotationScore(racedAnnotation.createdAt),
        racedAnnotation.annotationId,
      );
      return { outcome: 'duplicate', annotationId: racedAnnotation.annotationId };
    }

    await this.redis.zadd(
      metricIndexKey(ownerUserId, objectiveId, metricId),
      annotationScore(scored.createdAt),
      scored.annotationId,
    );
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
