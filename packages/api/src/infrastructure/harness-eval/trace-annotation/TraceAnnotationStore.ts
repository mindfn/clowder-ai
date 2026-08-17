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

    const serialized = JSON.stringify(annotation);
    const created = await this.redis.set(annotationKey(annotation.annotationId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(annotationKey(annotation.annotationId));
      if (existing !== serialized) throw new Error(`trace_annotation_conflict:${annotation.annotationId}`);
    }
    // A retry repairs a possible crash between record persistence and indexing.
    await this.redis.zadd(
      metricIndexKey(annotation.episodeRef.ownerUserId, annotation.objectiveId, annotation.metricId),
      annotation.createdAt,
      annotation.annotationId,
    );
    return { outcome: created === 'OK' ? 'created' : 'duplicate', annotationId: annotation.annotationId };
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
    const ids = await this.redis.zrangebyscore(metricIndexKey(ownerUserId, objectiveId, metricId), startMs, endMs - 1);
    const out: TraceAnnotation[] = [];
    for (const id of ids) {
      const annotation = await this.get(id);
      if (annotation) out.push(annotation);
    }
    return out;
  }
}
