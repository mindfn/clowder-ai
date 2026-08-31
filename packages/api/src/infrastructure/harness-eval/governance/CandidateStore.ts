/**
 * F257 CandidateStore — persistence for governance Candidates (judgment-schema-v1 §3).
 *
 * The conclusion→governance seam writes here: a `retire-candidate` eval verdict
 * opens exactly one Candidate per target segment (see GovernanceWorker). The
 * segment-lifeline read model projects `countPending` into `actionable`, so the
 * Console surfaces a REAL pending governance Candidate instead of the honest gap.
 *
 * Storage (owner-scoped through the segment index + durable context):
 *   - hash  `harness-governance-candidate`            { candidateId → Candidate JSON }
 *   - set   `harness-governance-candidate-owner:<owner>`       { candidateId, ... }
 *   - set   `harness-governance-candidate-segment:<owner>:<s>` { candidateId, ... }
 *
 * EC-* ids are deterministic hashes of the committed judgment + target segment,
 * so cold-start reconciliation repairs indexes without opening duplicates.
 */

import { randomUUID } from 'node:crypto';
import type { Candidate, PatchTrial } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const CANDIDATE_HASH = 'harness-governance-candidate';
const OWNER_INDEX_PREFIX = 'harness-governance-candidate-owner:';
const SEGMENT_INDEX_PREFIX = 'harness-governance-candidate-segment:';
const CANDIDATE_CONTEXT_HASH = 'harness-governance-candidate-context';
const PATCH_TRIAL_HASH = 'harness-governance-patch-trial';
const PATCH_TRIAL_INDEX_PREFIX = 'harness-governance-patch-trial-candidate:';
const DECISION_LOCK_PREFIX = 'harness-governance-candidate-decision-lock:';
const OPEN_INTERVENTION_LOCK_PREFIX = 'harness-governance-candidate-open-lock:';
const DECISION_LOCK_TTL_MS = 30_000;
const CANDIDATE_TYPES = new Set<Candidate['type']>([
  'redundant-duplicate',
  'redundant-cross-layer',
  'conflict-audience',
  'contradiction',
  'word-collision',
  'missing-segment',
  'retire-candidate',
]);
const CANDIDATE_ORIGINS = new Set<Candidate['originKind']>(['t1-static', 't3-gap', 'eval-verdict', 'live-incident']);
const CANDIDATE_MECHANISMS = new Set<Candidate['proposedAction']['mechanism']>([
  'override-disable',
  'override-content',
  'merge-segments',
  'add-guard',
  'rewrite',
  'intentional-keep',
  'none',
]);
const CANDIDATE_STATUSES = new Set<Candidate['status']>([
  'proposed',
  'approved',
  'rejected',
  'executing',
  'verifying',
  'closed',
  'falsified',
]);
const PATCH_TRIAL_OUTCOMES = new Set<PatchTrial['outcome']>([
  'improved',
  'no-change',
  'regressed',
  'inconclusive',
  'pending',
]);
const PATCH_TRIAL_DECISIONS = new Set<PatchTrial['decision']>(['solidify', 'rollback', 'falsified', 'pending']);

const redisKeyPart = (value: string) => encodeURIComponent(value);
const segmentIndexKey = (ownerUserId: string, segmentId: string) =>
  `${SEGMENT_INDEX_PREFIX}${redisKeyPart(ownerUserId)}:${redisKeyPart(segmentId)}`;
const ownerIndexKey = (ownerUserId: string) => `${OWNER_INDEX_PREFIX}${redisKeyPart(ownerUserId)}`;
const trialIndexKey = (candidateId: string) => `${PATCH_TRIAL_INDEX_PREFIX}${candidateId}`;

const APPROVE_AND_OPEN_TRIAL_LUA = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current ~= ARGV[2] then return 0 end
if redis.call('HEXISTS', KEYS[2], ARGV[4]) == 1 then return 2 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
redis.call('SADD', KEYS[3], ARGV[4])
return 1
`;
const COMPLETE_TRIAL_LUA = `
local candidate = redis.call('HGET', KEYS[1], ARGV[1])
local trial = redis.call('HGET', KEYS[2], ARGV[3])
if candidate ~= ARGV[2] or trial ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[5])
redis.call('HSET', KEYS[2], ARGV[3], ARGV[6])
return 1
`;
const CAS_CANDIDATE_LUA = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;
const RELEASE_DECISION_LOCK_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export interface CandidateEvaluationContext {
  ownerUserId: string;
  judgmentId: string;
  objectiveId: string;
  baselineEvaluationModelVersion: string;
  createdAt: number;
  baselineTraceHash: string;
  baselineMetricId: string;
  baseline: PatchTrial['baseline'];
}

export class CandidateStore {
  constructor(private readonly redis: RedisClient) {}

  /**
   * Serialize approve/reject across API processes while an external override
   * side effect is in flight. The token-checked release cannot unlock another
   * request after the lease expires.
   */
  async withDecisionLock<T>(candidateId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${DECISION_LOCK_PREFIX}${redisKeyPart(candidateId)}`;
    const token = await this.acquireLock(key);
    if (!token) throw new Error('governance_candidate_concurrent_transition');
    try {
      return await operation();
    } finally {
      await this.releaseLock(key, token);
    }
  }

  /**
   * Atomically serialize the "no open intervention -> create" transition for
   * one owner+segment. Two Objective judgments may commit concurrently; the
   * governance surface must still expose at most one live disable decision.
   */
  async createInterventionIfNone(
    candidate: Candidate,
    context: CandidateEvaluationContext,
    segmentId: string,
  ): Promise<'created' | 'duplicate' | 'blocked'> {
    const key = `${OPEN_INTERVENTION_LOCK_PREFIX}${redisKeyPart(context.ownerUserId)}:${redisKeyPart(segmentId)}`;
    const token = await this.acquireLock(key);
    if (!token) return 'blocked';
    try {
      // A deterministic Candidate id proves this exact judgment was already
      // governed, even if the Candidate is now closed or rejected. Replay the
      // idempotent write so a crash between hash/context/index writes repairs
      // every projection instead of stranding an invisible partial row.
      if (await this.get(candidate.candidateId)) return this.create(candidate, context);
      if (await this.hasOpenIntervention(context.ownerUserId, segmentId)) return 'blocked';
      return await this.create(candidate, context);
    } finally {
      await this.releaseLock(key, token);
    }
  }

  private async acquireLock(key: string): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', DECISION_LOCK_TTL_MS, 'NX');
    return acquired === 'OK' ? token : null;
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      await redisWithEval.eval(RELEASE_DECISION_LOCK_LUA, 1, key, token);
    } else if ((await this.redis.get(key)) === token) {
      await this.redis.del(key);
    }
  }

  /** Persist the durable in-progress state before executing the override. */
  async beginApproval(candidateId: string, approvedBy: string): Promise<Candidate> {
    const candidate = await this.get(candidateId);
    const context = await this.getEvaluationContext(candidateId);
    if (!candidate || !context || context.ownerUserId !== approvedBy) {
      throw new Error('governance_candidate_not_found');
    }
    if (candidate.status === 'executing') return candidate;
    if (candidate.status !== 'proposed') throw new Error('governance_candidate_not_proposed');
    const executing: Candidate = { ...candidate, status: 'executing' };
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      const committed = Number(
        await redisWithEval.eval(
          CAS_CANDIDATE_LUA,
          1,
          CANDIDATE_HASH,
          candidate.candidateId,
          JSON.stringify(candidate),
          JSON.stringify(executing),
        ),
      );
      if (committed !== 1) throw new Error('governance_candidate_concurrent_transition');
    } else {
      await this.redis.hset(CANDIDATE_HASH, executing.candidateId, JSON.stringify(executing));
    }
    return executing;
  }

  /** Persist a Candidate and add it to each target segment's pending index. */
  async create(candidate: Candidate, context: CandidateEvaluationContext): Promise<'created' | 'duplicate'> {
    const existing = await this.get(candidate.candidateId);
    if (existing && !sameCandidateIdentity(existing, candidate)) {
      throw new Error(`governance_candidate_conflict:${candidate.candidateId}`);
    }
    // Never regress an approved/closed Candidate back to proposed while
    // replaying the deterministic post-commit event. Only the initial write
    // creates the row; every retry below repairs context and indexes.
    if (!existing) await this.redis.hset(CANDIDATE_HASH, candidate.candidateId, JSON.stringify(candidate));
    const existingContext = await this.redis.hget(CANDIDATE_CONTEXT_HASH, candidate.candidateId);
    const serialized = JSON.stringify(context);
    if (existingContext && existingContext !== serialized) {
      throw new Error(`governance_candidate_context_conflict:${candidate.candidateId}`);
    }
    await this.redis.hset(CANDIDATE_CONTEXT_HASH, candidate.candidateId, serialized);
    await this.redis.sadd(ownerIndexKey(context.ownerUserId), candidate.candidateId);
    for (const segmentId of (existing ?? candidate).targetSegmentIds) {
      await this.redis.sadd(segmentIndexKey(context.ownerUserId, segmentId), candidate.candidateId);
    }
    return existing ? 'duplicate' : 'created';
  }

  /** Read one Candidate by id; null when absent or corrupted (fail-safe parse). */
  async get(candidateId: string): Promise<Candidate | null> {
    const raw = await this.redis.hget(CANDIDATE_HASH, candidateId);
    if (!raw) return null;
    try {
      return parseCandidate(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** All Candidates whose targetSegmentIds include the given segment. */
  async listBySegment(ownerUserId: string, segmentId: string): Promise<Candidate[]> {
    const ids = await this.redis.smembers(segmentIndexKey(ownerUserId, segmentId));
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const candidate = await this.get(id);
      const context = await this.getEvaluationContext(id);
      if (candidate && context?.ownerUserId === ownerUserId && candidate.targetSegmentIds.includes(segmentId)) {
        candidates.push(candidate);
      }
    }
    return candidates.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  }

  /** All durable Candidates owned by one operator, with corrupt rows omitted. */
  async listByOwner(ownerUserId: string): Promise<Candidate[]> {
    const ids = await this.redis.smembers(ownerIndexKey(ownerUserId));
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const candidate = await this.get(id);
      const context = await this.getEvaluationContext(id);
      if (candidate && context?.ownerUserId === ownerUserId) candidates.push(candidate);
    }
    return candidates.sort((left, right) => {
      const leftAt = left.approval.decidedAt ? Date.parse(left.approval.decidedAt) : 0;
      const rightAt = right.approval.decidedAt ? Date.parse(right.approval.decidedAt) : 0;
      return rightAt - leftAt || left.candidateId.localeCompare(right.candidateId);
    });
  }

  /**
   * Count Candidates for a segment that still need operator-visible handling.
   * `executing` remains actionable: it is the durable recovery marker written
   * before the external override side effect, and hiding it after an interrupted
   * request would strand the only safe retry path. Approved/rejected Candidates
   * no longer count as pending.
   */
  async countPending(ownerUserId: string, segmentId: string): Promise<number> {
    const candidates = await this.listBySegment(ownerUserId, segmentId);
    return candidates.filter((candidate) => candidate.status === 'proposed' || candidate.status === 'executing').length;
  }

  async hasOpenIntervention(ownerUserId: string, segmentId: string): Promise<boolean> {
    const candidates = await this.listBySegment(ownerUserId, segmentId);
    return candidates.some((candidate) =>
      ['proposed', 'approved', 'executing', 'verifying'].includes(candidate.status),
    );
  }

  /** Durable eval provenance behind a Candidate; malformed rows fail closed. */
  async getEvaluationContext(candidateId: string): Promise<CandidateEvaluationContext | null> {
    const raw = await this.redis.hget(CANDIDATE_CONTEXT_HASH, candidateId);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<CandidateEvaluationContext>;
      if (
        typeof value.ownerUserId !== 'string' ||
        typeof value.judgmentId !== 'string' ||
        typeof value.objectiveId !== 'string' ||
        typeof value.baselineEvaluationModelVersion !== 'string' ||
        value.baselineEvaluationModelVersion.length === 0 ||
        typeof value.createdAt !== 'number' ||
        !Number.isFinite(value.createdAt) ||
        typeof value.baselineTraceHash !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.baselineTraceHash) ||
        typeof value.baselineMetricId !== 'string' ||
        value.baselineMetricId.length === 0 ||
        !value.baseline ||
        !Number.isFinite(value.baseline.window?.startMs) ||
        !Number.isFinite(value.baseline.window?.endMs) ||
        value.baseline.window.startMs >= value.baseline.window.endMs ||
        !validMeasurement(value.baseline.measurement)
      ) {
        return null;
      }
      return value as CandidateEvaluationContext;
    } catch {
      return null;
    }
  }

  async approveAndOpenPatchTrial(input: {
    candidateId: string;
    approvedBy: string;
    note: string;
    hookId: string;
    approvedAt: number;
  }): Promise<{ candidate: Candidate; trial: PatchTrial }> {
    const candidate = await this.get(input.candidateId);
    if (!candidate) throw new Error('governance_candidate_not_found');
    const existingTrials = await this.listPatchTrials(candidate.candidateId);
    if (candidate.status !== 'proposed' && candidate.status !== 'executing') {
      const existing = existingTrials[0];
      if (candidate.approval.approvedBy === input.approvedBy && existing) return { candidate, trial: existing };
      throw new Error('governance_candidate_not_proposed');
    }
    const context = await this.getEvaluationContext(candidate.candidateId);
    if (!context) throw new Error('governance_candidate_baseline_unavailable');
    if (context.ownerUserId !== input.approvedBy) throw new Error('governance_candidate_owner_mismatch');
    const approvedAtIso = new Date(input.approvedAt).toISOString();
    const approved: Candidate = {
      ...candidate,
      status: 'approved',
      approval: { approvedBy: input.approvedBy, decidedAt: approvedAtIso, note: input.note },
    };
    const trial: PatchTrial = {
      schemaVersion: 2,
      trialId: `pt-${candidate.candidateId}-1`,
      candidateRef: candidate.candidateId,
      mechanism: candidate.proposedAction.mechanism,
      executedVia: `HookOverrideStore.disable(${input.hookId}, source=operator)`,
      baseline: context.baseline,
      treatment: {
        window: { startMs: input.approvedAt, endMs: input.approvedAt + 5 * 24 * 60 * 60 * 1000 },
        measurement: {
          kind: context.baseline.measurement.kind,
          value: context.baseline.measurement.value,
          how_counted: 'pending:not-yet-measured; placeholder=baseline',
        },
      },
      minWindowDays: 5,
      outcome: 'pending',
      decision: 'pending',
      trace: {
        beforeHash: context.baselineTraceHash,
        afterHash: 'pending:treatment-trace',
      },
    };
    return this.persistApprovedTrial(candidate, approved, trial, input.approvedBy);
  }

  private async persistApprovedTrial(
    candidate: Candidate,
    approved: Candidate,
    trial: PatchTrial,
    approvedBy: string,
  ): Promise<{ candidate: Candidate; trial: PatchTrial }> {
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      const committed = Number(
        await redisWithEval.eval(
          APPROVE_AND_OPEN_TRIAL_LUA,
          3,
          CANDIDATE_HASH,
          PATCH_TRIAL_HASH,
          trialIndexKey(candidate.candidateId),
          candidate.candidateId,
          JSON.stringify(candidate),
          JSON.stringify(approved),
          trial.trialId,
          JSON.stringify(trial),
        ),
      );
      if (committed !== 1) {
        const concurrentCandidate = await this.get(candidate.candidateId);
        const concurrentTrial = (await this.listPatchTrials(candidate.candidateId))[0];
        if (concurrentCandidate?.approval.approvedBy === approvedBy && concurrentTrial) {
          return { candidate: concurrentCandidate, trial: concurrentTrial };
        }
        throw new Error('governance_candidate_concurrent_transition');
      }
    } else {
      // Test/degraded clients without EVAL. Production always takes the atomic Lua path.
      await this.redis.hset(CANDIDATE_HASH, approved.candidateId, JSON.stringify(approved));
      await this.redis.hset(PATCH_TRIAL_HASH, trial.trialId, JSON.stringify(trial));
      await this.redis.sadd(trialIndexKey(candidate.candidateId), trial.trialId);
    }
    return { candidate: approved, trial };
  }

  /**
   * Apply a derived status transition only while the exact Candidate observed
   * by the worker is still current. A different Objective can settle the same
   * segment concurrently; a stale worker must never reopen a terminal row.
   */
  async updateCandidate(currentCandidate: Candidate, nextCandidate: Candidate): Promise<boolean> {
    if (currentCandidate.candidateId !== nextCandidate.candidateId) {
      throw new Error('governance_candidate_coordinate_mismatch');
    }
    const expected = JSON.stringify(currentCandidate);
    const next = JSON.stringify(nextCandidate);
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      return (
        Number(
          await redisWithEval.eval(CAS_CANDIDATE_LUA, 1, CANDIDATE_HASH, currentCandidate.candidateId, expected, next),
        ) === 1
      );
    }
    // Test/degraded clients without EVAL remain fail-closed. Production always
    // takes the atomic Lua path above.
    if ((await this.redis.hget(CANDIDATE_HASH, currentCandidate.candidateId)) !== expected) return false;
    await this.redis.hset(CANDIDATE_HASH, currentCandidate.candidateId, next);
    return true;
  }

  async reject(input: {
    candidateId: string;
    rejectedBy: string;
    note: string;
    rejectedAt: number;
  }): Promise<Candidate> {
    const candidate = await this.get(input.candidateId);
    const context = await this.getEvaluationContext(input.candidateId);
    if (!candidate || !context || context.ownerUserId !== input.rejectedBy) {
      throw new Error('governance_candidate_not_found');
    }
    if (candidate.status === 'rejected') return candidate;
    if (candidate.status !== 'proposed') throw new Error('governance_candidate_not_proposed');
    const rejected: Candidate = {
      ...candidate,
      status: 'rejected',
      approval: {
        approvedBy: null,
        decidedAt: new Date(input.rejectedAt).toISOString(),
        note: input.note,
      },
    };
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      const committed = Number(
        await redisWithEval.eval(
          CAS_CANDIDATE_LUA,
          1,
          CANDIDATE_HASH,
          candidate.candidateId,
          JSON.stringify(candidate),
          JSON.stringify(rejected),
        ),
      );
      if (committed !== 1) {
        const concurrent = await this.get(candidate.candidateId);
        if (concurrent?.status === 'rejected') return concurrent;
        throw new Error('governance_candidate_concurrent_transition');
      }
    } else {
      await this.redis.hset(CANDIDATE_HASH, rejected.candidateId, JSON.stringify(rejected));
    }
    return rejected;
  }

  async completePatchTrial(input: {
    currentCandidate: Candidate;
    nextCandidate: Candidate;
    currentTrial: PatchTrial;
    nextTrial: PatchTrial;
  }): Promise<void> {
    const redisWithEval = this.redis as RedisClient & { eval?: (...args: unknown[]) => Promise<unknown> };
    if (typeof redisWithEval.eval === 'function') {
      const committed = Number(
        await redisWithEval.eval(
          COMPLETE_TRIAL_LUA,
          2,
          CANDIDATE_HASH,
          PATCH_TRIAL_HASH,
          input.currentCandidate.candidateId,
          JSON.stringify(input.currentCandidate),
          input.currentTrial.trialId,
          JSON.stringify(input.currentTrial),
          JSON.stringify(input.nextCandidate),
          JSON.stringify(input.nextTrial),
        ),
      );
      if (committed !== 1) throw new Error('governance_patch_trial_concurrent_transition');
      return;
    }
    await this.redis.hset(CANDIDATE_HASH, input.nextCandidate.candidateId, JSON.stringify(input.nextCandidate));
    await this.redis.hset(PATCH_TRIAL_HASH, input.nextTrial.trialId, JSON.stringify(input.nextTrial));
  }

  /** PatchTrials for a Candidate (judgment-schema-v1 §4), oldest id first. */
  async listPatchTrials(candidateId: string): Promise<PatchTrial[]> {
    const ids = await this.redis.smembers(trialIndexKey(candidateId));
    const trials: PatchTrial[] = [];
    for (const id of ids) {
      const raw = await this.redis.hget(PATCH_TRIAL_HASH, id);
      if (!raw) continue;
      try {
        const trial = parsePatchTrial(JSON.parse(raw));
        if (trial) trials.push(trial);
      } catch {
        // Corrupt rows are unavailable, never synthesized.
      }
    }
    return trials.sort((left, right) => left.trialId.localeCompare(right.trialId));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCandidate(value: unknown): Candidate | null {
  if (!isRecord(value) || !isRecord(value.evidence) || !isRecord(value.proposedAction) || !isRecord(value.approval)) {
    return null;
  }
  if (
    typeof value.candidateId !== 'string' ||
    typeof value.type !== 'string' ||
    !CANDIDATE_TYPES.has(value.type as Candidate['type']) ||
    !Array.isArray(value.targetSegmentIds) ||
    !value.targetSegmentIds.every((item) => typeof item === 'string') ||
    typeof value.originKind !== 'string' ||
    !CANDIDATE_ORIGINS.has(value.originKind as Candidate['originKind']) ||
    !Array.isArray(value.evidence.anchors) ||
    !value.evidence.anchors.every((item) => typeof item === 'string') ||
    typeof value.evidence.summary !== 'string' ||
    typeof value.proposedAction.mechanism !== 'string' ||
    !CANDIDATE_MECHANISMS.has(value.proposedAction.mechanism as Candidate['proposedAction']['mechanism']) ||
    typeof value.proposedAction.rollback !== 'string' ||
    typeof value.status !== 'string' ||
    !CANDIDATE_STATUSES.has(value.status as Candidate['status']) ||
    !nullableString(value.approval.approvedBy) ||
    !nullableString(value.approval.decidedAt) ||
    !nullableString(value.approval.note)
  ) {
    return null;
  }
  return value as unknown as Candidate;
}

function parsePatchTrial(value: unknown): PatchTrial | null {
  if (!isRecord(value) || !isRecord(value.baseline) || !isRecord(value.treatment) || !isRecord(value.trace))
    return null;
  if (
    value.schemaVersion !== 2 ||
    typeof value.trialId !== 'string' ||
    typeof value.candidateRef !== 'string' ||
    typeof value.mechanism !== 'string' ||
    typeof value.executedVia !== 'string' ||
    !validTrialArm(value.baseline) ||
    !validTrialArm(value.treatment) ||
    typeof value.minWindowDays !== 'number' ||
    !Number.isFinite(value.minWindowDays) ||
    value.minWindowDays <= 0 ||
    typeof value.outcome !== 'string' ||
    !PATCH_TRIAL_OUTCOMES.has(value.outcome as PatchTrial['outcome']) ||
    typeof value.decision !== 'string' ||
    !PATCH_TRIAL_DECISIONS.has(value.decision as PatchTrial['decision']) ||
    typeof value.trace.beforeHash !== 'string' ||
    typeof value.trace.afterHash !== 'string'
  ) {
    return null;
  }
  return value as unknown as PatchTrial;
}

function validTrialArm(value: Record<string, unknown>): boolean {
  if (!isRecord(value.window) || !validMeasurement(value.measurement)) return false;
  return (
    typeof value.window.startMs === 'number' &&
    Number.isFinite(value.window.startMs) &&
    typeof value.window.endMs === 'number' &&
    Number.isFinite(value.window.endMs) &&
    value.window.startMs < value.window.endMs
  );
}

function validMeasurement(value: unknown): value is PatchTrial['baseline']['measurement'] {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'count' || value.kind === 'rate-badness') &&
    typeof value.value === 'number' &&
    Number.isFinite(value.value) &&
    value.value >= 0 &&
    (value.kind !== 'rate-badness' || value.value <= 1) &&
    typeof value.how_counted === 'string' &&
    value.how_counted.length > 0
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function sameCandidateIdentity(left: Candidate, right: Candidate): boolean {
  return (
    left.candidateId === right.candidateId &&
    left.type === right.type &&
    left.originKind === right.originKind &&
    left.targetSegmentIds.length === right.targetSegmentIds.length &&
    left.targetSegmentIds.every((segmentId, index) => segmentId === right.targetSegmentIds[index]) &&
    left.evidence.summary === right.evidence.summary &&
    left.evidence.anchors.length === right.evidence.anchors.length &&
    left.evidence.anchors.every((anchor, index) => anchor === right.evidence.anchors[index]) &&
    left.proposedAction.mechanism === right.proposedAction.mechanism &&
    left.proposedAction.rollback === right.proposedAction.rollback
  );
}
