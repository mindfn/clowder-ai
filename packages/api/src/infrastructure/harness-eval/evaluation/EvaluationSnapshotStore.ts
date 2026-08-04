import type { EvaluationSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SNAPSHOT_PREFIX = 'harness-evaluation-snapshot:';
const SNAPSHOT_INDEX_PREFIX = 'harness-evaluation-snapshot-index:';
const CONSUMED_PREFIX = 'harness-evaluation-consumed-annotation:';

const snapshotKey = (snapshotId: string) => `${SNAPSHOT_PREFIX}${snapshotId}`;
const metricCoordinate = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${ownerUserId}:${objectiveId}:${metricId}`;
const snapshotIndexKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${SNAPSHOT_INDEX_PREFIX}${metricCoordinate(ownerUserId, objectiveId, metricId)}`;
const consumedKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${CONSUMED_PREFIX}${metricCoordinate(ownerUserId, objectiveId, metricId)}`;

export class EvaluationSnapshotStore {
  constructor(private readonly redis: RedisClient) {}

  async append(snapshot: EvaluationSnapshot): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = JSON.stringify(snapshot);
    const created = await this.redis.set(snapshotKey(snapshot.snapshotId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(snapshotKey(snapshot.snapshotId));
      if (existing !== serialized) throw new Error(`evaluation_snapshot_conflict:${snapshot.snapshotId}`);
    }
    await this.redis.zadd(
      snapshotIndexKey(snapshot.ownerUserId, snapshot.objectiveId, snapshot.metricId),
      snapshot.createdAt,
      snapshot.snapshotId,
    );
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(snapshotId: string): Promise<EvaluationSnapshot | null> {
    const raw = await this.redis.get(snapshotKey(snapshotId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EvaluationSnapshot;
    } catch {
      return null;
    }
  }

  async consumedAnnotationIds(ownerUserId: string, objectiveId: string, metricId: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(consumedKey(ownerUserId, objectiveId, metricId)));
  }

  async markAnnotationsConsumed(snapshot: EvaluationSnapshot): Promise<void> {
    if (snapshot.annotationIds.length === 0) return;
    await this.redis.sadd(
      consumedKey(snapshot.ownerUserId, snapshot.objectiveId, snapshot.metricId),
      ...snapshot.annotationIds,
    );
  }
}
