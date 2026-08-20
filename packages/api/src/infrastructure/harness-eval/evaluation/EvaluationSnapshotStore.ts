import type { EvaluationSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SNAPSHOT_PREFIX = 'harness-evaluation-snapshot:';
const SNAPSHOT_INDEX_PREFIX = 'harness-evaluation-snapshot-index:';
const CONSUMED_PREFIX = 'harness-evaluation-consumed-annotation:';
const COMPLETED_INDEX_PREFIX = 'harness-evaluation-completed-snapshot-index:';

const snapshotKey = (snapshotId: string) => `${SNAPSHOT_PREFIX}${snapshotId}`;
const unitCoordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const snapshotIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${SNAPSHOT_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const consumedKey = (ownerUserId: string, objectiveId: string) =>
  `${CONSUMED_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const completedIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${COMPLETED_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;

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
      snapshotIndexKey(snapshot.ownerUserId, snapshot.objectiveId),
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

  async latest(ownerUserId: string, objectiveId: string): Promise<EvaluationSnapshot | null> {
    const ids = await this.redis.zrevrange(snapshotIndexKey(ownerUserId, objectiveId), 0, 0);
    return ids[0] ? this.get(ids[0]) : null;
  }

  async latestCompleted(ownerUserId: string, objectiveId: string): Promise<EvaluationSnapshot | null> {
    const ids = await this.redis.zrevrange(completedIndexKey(ownerUserId, objectiveId), 0, 0);
    return ids[0] ? this.get(ids[0]) : null;
  }

  async consumedAnnotationIds(ownerUserId: string, objectiveId: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(consumedKey(ownerUserId, objectiveId)));
  }

  async markAnnotationsConsumed(snapshot: EvaluationSnapshot): Promise<void> {
    if (snapshot.annotationIds.length === 0) return;
    await this.redis.sadd(consumedKey(snapshot.ownerUserId, snapshot.objectiveId), ...snapshot.annotationIds);
  }

  async markCompleted(snapshot: EvaluationSnapshot): Promise<void> {
    await this.redis.zadd(
      completedIndexKey(snapshot.ownerUserId, snapshot.objectiveId),
      snapshot.createdAt,
      snapshot.snapshotId,
    );
  }
}
