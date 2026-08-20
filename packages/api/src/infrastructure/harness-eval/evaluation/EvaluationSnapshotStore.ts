import type { EvaluationSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SNAPSHOT_PREFIX = 'harness-evaluation-snapshot:';
const SNAPSHOT_INDEX_PREFIX = 'harness-evaluation-snapshot-index:';
const CONSUMED_PREFIX = 'harness-evaluation-consumed-annotation:';
const COMPLETED_INDEX_PREFIX = 'harness-evaluation-completed-snapshot-index:';
const UNIT_RUN_WATERMARK_PREFIX = 'harness-unit-run-watermark:';

const snapshotKey = (snapshotId: string) => `${SNAPSHOT_PREFIX}${snapshotId}`;
const unitCoordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const snapshotIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${SNAPSHOT_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const consumedKey = (ownerUserId: string, objectiveId: string) =>
  `${CONSUMED_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const completedIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${COMPLETED_INDEX_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitRunWatermarkKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_WATERMARK_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;

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
    // F257 P1-2: the completed index and the Unit-run watermark must share the
    // same exclusive upper bound so non-atomic callers (test helpers, fallback
    // paths) stay consistent with the Lua commit path.
    await this.redis.zadd(
      completedIndexKey(snapshot.ownerUserId, snapshot.objectiveId),
      snapshot.window.end,
      snapshot.snapshotId,
    );
    await this.redis.set(unitRunWatermarkKey(snapshot.ownerUserId, snapshot.objectiveId), String(snapshot.window.end));
  }

  /**
   * F257 P1-2: the canonical completed watermark for the Unit. This is the
   * exclusive upper bound of the last completed Unit run and the inclusive start
   * of the next run. Reads from the single Unit-run watermark key rather than
   * deriving it from the completed index, so concurrent workers share one truth.
   */
  async completedWatermark(ownerUserId: string, objectiveId: string): Promise<number> {
    const raw = await this.redis.get(unitRunWatermarkKey(ownerUserId, objectiveId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
