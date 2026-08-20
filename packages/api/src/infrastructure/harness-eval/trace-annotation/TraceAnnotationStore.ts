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

/** Composite score scale. Score = createdAt * SCALE + sequence. */
export const ANNOTATION_SCORE_SCALE = 1_000_000_000;

export function annotationScore(createdAt: number, sequence: number): number {
  return createdAt * ANNOTATION_SCORE_SCALE + sequence;
}

export function annotationScoreTimestamp(score: number): number {
  return Math.floor(score / ANNOTATION_SCORE_SCALE);
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
    const sequence = Number(await this.redis.incr(sequenceKey(ownerUserId, objectiveId)));
    const scored = { ...annotation, sequence };

    const serialized = JSON.stringify(scored);
    const created = await this.redis.set(annotationKey(scored.annotationId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(annotationKey(scored.annotationId));
      if (existing !== serialized) throw new Error(`trace_annotation_conflict:${scored.annotationId}`);
    }
    // A retry repairs a possible crash between record persistence and indexing.
    const score = annotationScore(scored.createdAt, sequence);
    await this.redis.zadd(metricIndexKey(ownerUserId, objectiveId, scored.metricId), score, scored.annotationId);
    return { outcome: created === 'OK' ? 'created' : 'duplicate', annotationId: scored.annotationId };
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
    startMs: number,
    endMs: number,
  ): Promise<TraceAnnotation[]> {
    // Half-open score range [start, end): an annotation whose score equals the
    // upper bound belongs to the next Unit run, matching the composite watermark
    // semantics used by the scheduler.
    const ids = await this.redis.zrangebyscore(
      metricIndexKey(ownerUserId, objectiveId, metricId),
      String(startMs),
      `(${endMs}`,
    );
    const out: TraceAnnotation[] = [];
    for (const id of ids) {
      const annotation = await this.get(id);
      if (annotation) out.push(annotation);
    }
    return out;
  }
}
