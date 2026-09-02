import { createHash } from 'node:crypto';
import type { EvaluationUnitRef, TraceEpisode } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

const OBJECTIVE_TRACE_PREFIX = 'harness-objective-trace:';
const OBJECTIVE_TRACE_BACKFILL_PREFIX = 'harness-objective-trace-backfill:';

const objectiveTraceKey = (ownerUserId: string, objectiveId: string) =>
  `${OBJECTIVE_TRACE_PREFIX}${ownerUserId}:${objectiveId}`;

/**
 * Additive projection from canonical trace episodes to Objective observations.
 * One ZSET member represents one distinct invocation, so readiness reads stay
 * O(log N) regardless of the evidence-window length.
 */
export class ObjectiveTraceIndex {
  private readonly objectiveIdsBySegment = new Map<string, string[]>();
  private readonly allUnitRefs: EvaluationUnitRef[];
  private readonly backfillRevision: string;
  private readonly ownerBackfills = new Map<string, Promise<void>>();

  constructor(
    private readonly redis: RedisClient,
    catalog: EvaluationCatalog,
    private readonly traces: Pick<InjectionTraceStore, 'queryUnitWindow'>,
  ) {
    const coordinates = catalog.manifest.units.map((unit) => {
      const objectiveIds = [...new Set(unit.objectives.map((attachment) => attachment.objectiveId))].sort();
      this.objectiveIdsBySegment.set(unit.unitId, objectiveIds);
      return [unit.unitId, objectiveIds] as const;
    });
    this.allUnitRefs = coordinates.map(([unitId]) => ({ unitType: 'segment', unitId }));
    this.backfillRevision = createHash('sha256').update(JSON.stringify(coordinates)).digest('hex').slice(0, 16);
  }

  async ensureOwnerBackfilled(ownerUserId: string, now: number): Promise<void> {
    let pending = this.ownerBackfills.get(ownerUserId);
    if (!pending) {
      pending = this.backfillOwner(ownerUserId, now).catch((error) => {
        this.ownerBackfills.delete(ownerUserId);
        throw error;
      });
      this.ownerBackfills.set(ownerUserId, pending);
    }
    await pending;
  }

  async indexEpisode(episode: TraceEpisode): Promise<string[]> {
    const objectiveIds = this.objectiveIdsForEpisode(episode);
    await Promise.all(
      objectiveIds.map((objectiveId) =>
        this.redis.zadd(
          objectiveTraceKey(episode.terminal.ownerUserId, objectiveId),
          episode.terminal.terminalAt,
          episode.terminal.invocationId,
        ),
      ),
    );
    return objectiveIds;
  }

  async countWindow(ownerUserId: string, objectiveId: string, start: number, end: number): Promise<number> {
    await this.ensureOwnerBackfilled(ownerUserId, end);
    if (end <= start) return 0;
    return this.redis.zcount(objectiveTraceKey(ownerUserId, objectiveId), start, end - 1);
  }

  async earliest(ownerUserId: string, objectiveId: string, now: number): Promise<number | null> {
    await this.ensureOwnerBackfilled(ownerUserId, now);
    const first = (await this.redis.zrange(
      objectiveTraceKey(ownerUserId, objectiveId),
      0,
      0,
      'WITHSCORES',
    )) as string[];
    if (first.length === 0) return null;
    const terminalAt = Number(first[1]);
    if (!Number.isFinite(terminalAt) || terminalAt < 0) {
      throw new Error(`invalid_objective_trace_score:${ownerUserId}:${objectiveId}`);
    }
    return terminalAt;
  }

  private async backfillOwner(ownerUserId: string, now: number): Promise<void> {
    const markerKey = `${OBJECTIVE_TRACE_BACKFILL_PREFIX}${this.backfillRevision}:${ownerUserId}`;
    if (await this.redis.get(markerKey)) return;
    const end = Math.min(Number.MAX_SAFE_INTEGER, now + 1);
    const episodes = await this.traces.queryUnitWindow(ownerUserId, this.allUnitRefs, 0, end);
    for (const episode of episodes) await this.indexEpisode(episode);
    await this.redis.set(markerKey, '1');
  }

  private objectiveIdsForEpisode(episode: TraceEpisode): string[] {
    const objectiveIds = new Set<string>();
    for (const segment of episode.summary.segments) {
      if (segment.status !== 'observed') continue;
      for (const objectiveId of this.objectiveIdsBySegment.get(segment.segmentId) ?? []) {
        objectiveIds.add(objectiveId);
      }
    }
    return [...objectiveIds].sort();
  }
}
