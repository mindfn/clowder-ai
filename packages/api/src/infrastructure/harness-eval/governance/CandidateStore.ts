/**
 * F257 CandidateStore — persistence for governance Candidates (judgment-schema-v1 §3).
 *
 * The conclusion→governance seam writes here: a `retire-candidate` eval verdict
 * opens exactly one Candidate per target segment (see GovernanceWorker). The
 * segment-lifeline read model projects `countPending` into `actionable`, so the
 * Console surfaces a REAL pending governance Candidate instead of the honest gap.
 *
 * Storage (owner-agnostic; the Unit segment id is the scoping coordinate):
 *   - hash  `harness-governance-candidate`            { candidateId → Candidate JSON }
 *   - set   `harness-governance-candidate-segment:<s>` { candidateId, ... }  (per-segment index)
 *   - str   `harness-governance-candidate-seq`          monotonic EC-* counter
 *
 * EC-* ids are deterministic (redis INCR), format `EC-<n>`.
 */

import type { Candidate, PatchTrial } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const CANDIDATE_HASH = 'harness-governance-candidate';
const CANDIDATE_SEQ = 'harness-governance-candidate-seq';
const SEGMENT_INDEX_PREFIX = 'harness-governance-candidate-segment:';

const segmentIndexKey = (segmentId: string) => `${SEGMENT_INDEX_PREFIX}${segmentId}`;

export class CandidateStore {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Allocate the next deterministic EC-* Candidate id from a redis INCR counter.
   * The worker reserves the id, then builds and persists the full frozen §3 object.
   */
  async nextCandidateId(): Promise<string> {
    const seq = await this.redis.incr(CANDIDATE_SEQ);
    return `EC-${seq}`;
  }

  /** Persist a Candidate and add it to each target segment's pending index. */
  async create(candidate: Candidate): Promise<void> {
    await this.redis.hset(CANDIDATE_HASH, candidate.candidateId, JSON.stringify(candidate));
    for (const segmentId of candidate.targetSegmentIds) {
      await this.redis.sadd(segmentIndexKey(segmentId), candidate.candidateId);
    }
  }

  /** Read one Candidate by id; null when absent or corrupted (fail-safe parse). */
  async get(candidateId: string): Promise<Candidate | null> {
    const raw = await this.redis.hget(CANDIDATE_HASH, candidateId);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Candidate;
    } catch {
      return null;
    }
  }

  /** All Candidates whose targetSegmentIds include the given segment. */
  async listBySegment(segmentId: string): Promise<Candidate[]> {
    const ids = await this.redis.smembers(segmentIndexKey(segmentId));
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const candidate = await this.get(id);
      if (candidate) candidates.push(candidate);
    }
    return candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  }

  /**
   * Count Candidates for a segment that still await an operator decision
   * (status 'proposed'). This is the only authority for the route's `actionable`
   * projection — an approved/rejected Candidate no longer counts as pending.
   */
  async countPending(segmentId: string): Promise<number> {
    const candidates = await this.listBySegment(segmentId);
    return candidates.filter((candidate) => candidate.status === 'proposed').length;
  }

  /**
   * PatchTrials for a Candidate (judgment-schema-v1 §4). Leg 2 (approval→override→
   * PatchTrial) is not wired yet, so this returns the honest empty set rather than
   * fabricating a trial. The read contract is stable for when the executor lands.
   */
  async listPatchTrials(_candidateId: string): Promise<PatchTrial[]> {
    return [];
  }
}
