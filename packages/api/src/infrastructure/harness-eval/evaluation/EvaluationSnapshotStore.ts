import type { EvaluationSnapshot } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const SNAPSHOT_PREFIX = 'harness-evaluation-snapshot:';
const CONSUMED_PREFIX = 'harness-evaluation-consumed-annotation:';
const UNIT_RUN_COMPLETED_WINDOW_END_PREFIX = 'harness-unit-run-completed-window-end:';

const snapshotKey = (snapshotId: string) => `${SNAPSHOT_PREFIX}${snapshotId}`;
const unitCoordinate = (ownerUserId: string, objectiveId: string) => `${ownerUserId}:${objectiveId}`;
const consumedKey = (ownerUserId: string, objectiveId: string) =>
  `${CONSUMED_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;
const unitRunCompletedWindowEndKey = (ownerUserId: string, objectiveId: string) =>
  `${UNIT_RUN_COMPLETED_WINDOW_END_PREFIX}${unitCoordinate(ownerUserId, objectiveId)}`;

export class EvaluationSnapshotStore {
  constructor(private readonly redis: RedisClient) {}

  async get(snapshotId: string): Promise<EvaluationSnapshot | null> {
    const raw = await this.redis.get(snapshotKey(snapshotId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EvaluationSnapshot;
    } catch {
      return null;
    }
  }

  async consumedAnnotationIds(ownerUserId: string, objectiveId: string): Promise<Set<string>> {
    return new Set(await this.redis.smembers(consumedKey(ownerUserId, objectiveId)));
  }

  /**
   * F257 R11: the completed-window-end is the exclusive upper bound of the last
   * completed Unit run. It is the semantic start of the next Unit window.
   */
  async completedWindowEnd(ownerUserId: string, objectiveId: string): Promise<number> {
    const raw = await this.redis.get(unitRunCompletedWindowEndKey(ownerUserId, objectiveId));
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
